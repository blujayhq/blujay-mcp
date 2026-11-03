// Reading a file the user named, for send_message. Only photos, videos, documents (PDF, Word,
// Excel, PowerPoint as .docx/.xlsx/.pptx), contact cards and audio (sent as a voice memo) are sent, judged by the
// file's bytes rather than its name, the same way Blujay checks an upload. Text files, code,
// keys, secrets, plain archives and programs are never sent.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Blujay's limit for one attachment (`POST /v1/attachments`). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** The file can't be sent; the message says why in plain words. */
export class FileRefusedError extends Error {}

export type FileKind = "photo" | "video" | "document" | "contact card" | "audio";

export interface SendableFile {
    bytes: Buffer;
    kind: FileKind;
    /** What Blujay is told the file is: image/jpeg, video/quicktime, text/vcard, ... */
    contentType: string;
    /** The name the recipient sees, with the extension that matches the contents. */
    filename: string;
    /** Hex SHA-256 of the bytes, so a repeat of the same file is recognised. */
    sha256: string;
}

interface DetectedType {
    contentType: string;
    extension: string;
    kind: FileKind;
}

const ISO_IMAGE_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
// Boxes that hold the track boxes, on the way to each track's handler.
const ISO_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "edts", "udta", "mvex", "moof", "traf"]);

function startsWith(bytes: Buffer, prefix: number[]): boolean {
    return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Buffer, start: number, end: number): string {
    return bytes.toString("latin1", start, end);
}

function readBox(bytes: Buffer, offset: number, limit: number): { type: string; start: number; end: number } | null {
    if (offset + 8 > limit) return null;
    const size = bytes.readUInt32BE(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    let header = 8;
    let end: number;
    if (size === 1) {
        if (offset + 16 > limit) return null;
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(limit - offset)) return null;
        header = 16;
        end = offset + Number(large);
    } else if (size === 0) {
        end = limit;
    } else {
        end = offset + size;
    }
    if (end < offset + header || end > limit) return null;
    return { type, start: offset + header, end };
}

/** Whether an MP4/MOV file has a video track: a track handler (`hdlr`) of type `vide`. */
function hasVideoTrack(bytes: Buffer, start: number, limit: number, depth = 0): boolean {
    for (let offset = start; offset + 8 <= limit; ) {
        const box = readBox(bytes, offset, limit);
        if (!box) return false;
        if (box.type === "hdlr" && box.start + 12 <= box.end && ascii(bytes, box.start + 8, box.start + 12) === "vide") return true;
        if (depth < 8 && ISO_CONTAINERS.has(box.type) && hasVideoTrack(bytes, box.start, box.end, depth + 1)) return true;
        offset = box.end;
    }
    return false;
}

function detectIsoMedia(bytes: Buffer): DetectedType | null {
    const ftyp = readBox(bytes, 0, bytes.length);
    if (!ftyp || ftyp.type !== "ftyp" || ftyp.start + 8 > ftyp.end) return null;
    const brands = [ascii(bytes, ftyp.start, ftyp.start + 4)];
    for (let offset = ftyp.start + 8; offset + 4 <= ftyp.end; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
    if (brands.some((brand) => ISO_IMAGE_BRANDS.has(brand))) {
        return brands.includes("avif")
            ? { contentType: "image/avif", extension: ".avif", kind: "photo" }
            : { contentType: "image/heic", extension: ".heic", kind: "photo" };
    }
    if (hasVideoTrack(bytes, ftyp.end, bytes.length)) {
        return brands.includes("qt  ")
            ? { contentType: "video/quicktime", extension: ".mov", kind: "video" }
            : { contentType: "video/mp4", extension: ".mp4", kind: "video" };
    }
    // An MPEG-4 audio file (major brand M4A, M4B or M4P), as Blujay recognises it.
    if (["M4A ", "M4B ", "M4P "].includes(brands[0]!)) return { contentType: "audio/mp4", extension: ".m4a", kind: "audio" };
    return null;
}

/** A whole-file vCard: UTF-8 with no NUL bytes, from BEGIN:VCARD to END:VCARD. */
function isVcard(bytes: Buffer): boolean {
    if (bytes.includes(0)) return false;
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return false;
    }
    return /^﻿?\s*BEGIN:VCARD\r?\n/i.test(text) && /\r?\nEND:VCARD\s*$/i.test(text);
}

/**
 * An MP3 that starts with a frame header rather than an ID3 tag: frame sync, a real MPEG version,
 * Layer III, and valid bitrate and sample-rate indexes. A bare FF Ex check also matches the FF FE
 * that starts UTF-16 text files, which would let a text file go out as a "voice memo".
 */
function isMp3Frame(bytes: Buffer): boolean {
    if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false;
    const version = (bytes[1]! >> 3) & 0x03;
    const layer = (bytes[1]! >> 1) & 0x03;
    const bitrate = bytes[2]! >> 4;
    const sampleRate = (bytes[2]! >> 2) & 0x03;
    return version !== 0x01 && layer === 0x01 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

/**
 * Audio Blujay sends as a voice memo, by the same byte checks as its upload policy: MP3, AAC,
 * WAV, CAF, FLAC and Ogg (M4A is found with the other MPEG-4 files). WebM is left out because
 * the first bytes don't tell WebM audio from WebM video.
 */
function detectAudio(bytes: Buffer): DetectedType | null {
    if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return { contentType: "audio/mpeg", extension: ".mp3", kind: "audio" };
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return { contentType: "audio/aac", extension: ".aac", kind: "audio" };
    if (isMp3Frame(bytes)) return { contentType: "audio/mpeg", extension: ".mp3", kind: "audio" };
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return { contentType: "audio/wav", extension: ".wav", kind: "audio" };
    if (bytes.length >= 4 && ascii(bytes, 0, 4) === "caff") return { contentType: "audio/x-caf", extension: ".caf", kind: "audio" };
    if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return { contentType: "audio/flac", extension: ".flac", kind: "audio" };
    if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return { contentType: "audio/ogg", extension: ".ogg", kind: "audio" };
    return null;
}

const OOXML_PARTS: Array<[string, DetectedType]> = [
    ["word/document.xml", { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", kind: "document" }],
    ["xl/workbook.xml", { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx", kind: "document" }],
    ["ppt/presentation.xml", { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx", kind: "document" }],
];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

/** The CRC-32 a zip records for each entry. */
export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** Uncompressed size a document's parts may add up to; a zip that inflates past it is refused. */
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;

/**
 * The entry names of a zip, or null unless the zip is complete and self-consistent: one end
 * record that finishes the file, a central directory that ends where that record starts and lists
 * exactly the entries it says, and local entries that fill every byte before the directory with
 * the same names. So no file can hide in the zip where another zip tool would still find it.
 */
function zipEntryNames(bytes: Buffer): string[] | null {
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
        if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) {
            end = at;
            break;
        }
    }
    if (end < 0) return null;
    const count = bytes.readUInt16LE(end + 10);
    const directorySize = bytes.readUInt32LE(end + 12);
    const directoryOffset = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) return null;
    if (count === 0 || count === 0xffff || directoryOffset + directorySize !== end) return null;
    const entries: Array<{ name: string; local: number; size: number; unzipped: number; crc: number; method: number; flags: number }> = [];
    let offset = directoryOffset;
    while (offset < end) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return null;
        const flags = bytes.readUInt16LE(offset + 8);
        const method = bytes.readUInt16LE(offset + 10);
        const crc = bytes.readUInt32LE(offset + 16);
        const size = bytes.readUInt32LE(offset + 20);
        const unzipped = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
        const local = bytes.readUInt32LE(offset + 42);
        if (next > end || size === 0xffffffff || unzipped === 0xffffffff || local === 0xffffffff) return null;
        // Stored or deflated only, never encrypted, and a stored entry can't defer its sizes to a data descriptor.
        if ((method !== 0 && method !== 8) || flags & 0x01 || (method === 0 && flags & 0x08)) return null;
        entries.push({ name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength), local, size, unzipped, crc, method, flags });
        offset = next;
    }
    if (offset !== end || entries.length !== count) return null;
    if (entries.reduce((total, entry) => total + entry.unzipped, 0) > MAX_UNZIPPED_BYTES) return null;
    // Local entries must follow one another from the first byte to the directory, each with the
    // same name, sizes and checksum as its directory record, and data that really is that long:
    // a stored entry's checksum must match, and a deflated entry must inflate to exactly its size
    // and checksum, ending exactly where the next entry starts. So what a streaming unzip tool
    // reads is what the directory says.
    let position = 0;
    for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
        if (entry.local !== position || position + 30 > directoryOffset || bytes.readUInt32LE(position) !== 0x04034b50) return null;
        if (bytes.readUInt16LE(position + 6) !== entry.flags || bytes.readUInt16LE(position + 8) !== entry.method) return null;
        const nameLength = bytes.readUInt16LE(position + 26);
        const extraLength = bytes.readUInt16LE(position + 28);
        if (bytes.toString("utf8", position + 30, position + 30 + nameLength) !== entry.name) return null;
        const recorded = { crc: bytes.readUInt32LE(position + 14), size: bytes.readUInt32LE(position + 18), unzipped: bytes.readUInt32LE(position + 22) };
        const dataStart = position + 30 + nameLength + extraLength;
        const dataEnd = dataStart + entry.size;
        if (dataEnd > directoryOffset) return null;
        const data = bytes.subarray(dataStart, dataEnd);
        let unzipped: Buffer;
        try {
            if (entry.method === 0) {
                unzipped = data;
            } else {
                const result = inflateRawSync(data, { info: true, maxOutputLength: Math.max(1, entry.unzipped) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
                if (result.engine.bytesWritten !== entry.size) return null;
                unzipped = result.buffer;
            }
        } catch {
            return null;
        }
        if (unzipped.length !== entry.unzipped || crc32(unzipped) !== entry.crc) return null;
        position = dataEnd;
        if (entry.flags & 0x08) {
            // The sizes follow the data in a descriptor (with or without its signature); they must match too.
            if (position + 4 <= directoryOffset && bytes.readUInt32LE(position) === 0x08074b50) position += 4;
            if (position + 12 > directoryOffset) return null;
            const described = { crc: bytes.readUInt32LE(position), size: bytes.readUInt32LE(position + 4), unzipped: bytes.readUInt32LE(position + 8) };
            if (described.crc !== entry.crc || described.size !== entry.size || described.unzipped !== entry.unzipped) return null;
            position += 12;
        } else if (recorded.crc !== entry.crc || recorded.size !== entry.size || recorded.unzipped !== entry.unzipped) {
            return null;
        }
    }
    return position === directoryOffset ? entries.map((entry) => entry.name) : null;
}

const OFFICE_FOLDERS = ["word/", "xl/", "ppt/", "docProps/", "_rels/", "customXml/", "docMetadata/", "customUI/", "[trash]/"];
// Parts an Office package holds: XML and relationships, pictures, fonts, embedded media and objects.
const OFFICE_PART_EXTENSIONS = new Set([
    ".xml", ".rels", ".vml", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".emf", ".wmf", ".svg", ".wdp",
    ".odttf", ".fntdata", ".bin", ".mp4", ".m4a", ".mp3", ".wav", ".docx", ".xlsx", ".pptx",
]);

/** A part of a Word, Excel or PowerPoint package: in an Office folder, with an Office part's extension, never macros or a path that climbs out. */
function isOfficePart(name: string): boolean {
    if (name === "[Content_Types].xml") return true;
    if (name.includes("..") || name.includes("\\") || name.startsWith("/") || /(^|\/)vbaProject\.bin$/i.test(name)) return false;
    const dot = name.lastIndexOf(".");
    const extension = dot > name.lastIndexOf("/") ? name.slice(dot).toLowerCase() : "";
    return OFFICE_FOLDERS.some((folder) => name.startsWith(folder)) && OFFICE_PART_EXTENSIONS.has(extension);
}

/**
 * A Word, Excel or PowerPoint file (.docx, .xlsx, .pptx). These are zips, so the zip must be
 * complete and hold the package's content-type list, its main part and only Office parts: a zip
 * of anything else renamed .docx is refused. Legacy .doc/.xls/.ppt compound files aren't sent:
 * telling them from other compound files (saved emails, installers) safely needs a full parser.
 */
function detectOfficeDocument(bytes: Buffer): DetectedType | null {
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
        const names = zipEntryNames(bytes);
        if (!names || !names.includes("[Content_Types].xml")) return null;
        const match = OOXML_PARTS.find(([part]) => names.includes(part));
        if (!match) return null;
        return names.every(isOfficePart) ? match[1] : null;
    }
    return null;
}

/** A PDF starts with %PDF- and ends with an %%EOF marker, with nothing but whitespace after it. */
function isPdf(bytes: Buffer): boolean {
    return bytes.length >= 12 && ascii(bytes, 0, 5) === "%PDF-" && /%%EOF[\s\0]*$/.test(ascii(bytes, Math.max(0, bytes.length - 1024), bytes.length));
}

/** What a file is from its bytes, or null when it isn't a photo, a video, a document, a contact card or audio. */
export function detectFileType(bytes: Buffer): DetectedType | null {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: ".jpg", kind: "photo" };
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", extension: ".png", kind: "photo" };
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return { contentType: "image/gif", extension: ".gif", kind: "photo" };
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { contentType: "image/webp", extension: ".webp", kind: "photo" };
    const iso = detectIsoMedia(bytes);
    if (iso) return iso;
    const audio = detectAudio(bytes);
    if (audio) return audio;
    if (isPdf(bytes)) return { contentType: "application/pdf", extension: ".pdf", kind: "document" };
    const office = detectOfficeDocument(bytes);
    if (office) return office;
    if (isVcard(bytes)) return { contentType: "text/vcard", extension: ".vcf", kind: "contact card" };
    return null;
}

/** `~/Desktop/a.jpg` or `/Users/ava/Desktop/a.jpg`. A relative path depends on where the server started, so it's refused. */
export function resolveUserPath(path: string): string {
    const trimmed = path.trim();
    if (trimmed === "~" || trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(1));
    if (!isAbsolute(trimmed)) {
        throw new FileRefusedError("Not sent: give the file's full path, like ~/Desktop/photo.jpg or /Users/you/Desktop/photo.jpg.");
    }
    return trimmed;
}

/** The recipient sees this name: the file's own name with the extension that matches its contents. */
function sendName(path: string, extension: string): string {
    const stem = basename(path, extname(path)).replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 200);
    return `${stem || "attachment"}${extension}`;
}

function unreadable(resolved: string, error: unknown): FileRefusedError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return new FileRefusedError(`Not sent: there's no file at ${resolved}.`);
    if (code === "EACCES" || code === "EPERM") return new FileRefusedError(`Not sent: this server isn't allowed to read ${resolved}.`);
    return new FileRefusedError(`Not sent: couldn't read ${resolved} (${code ?? "unknown error"}).`);
}

/**
 * Reads exactly `size` bytes from an open file. If it holds fewer or more than when it was
 * checked, it changed while being read, and it's refused rather than sent half-written.
 */
export async function readExactly(handle: FileHandle, size: number, resolved: string): Promise<Buffer> {
    const bytes = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
        const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
    }
    const { bytesRead: extra } = await handle.read(Buffer.alloc(1), 0, 1, size);
    if (filled !== size || extra !== 0) throw new FileRefusedError(`Not sent: ${resolved} changed while it was being read. Try again once it's saved.`);
    return bytes;
}

/** Reads a file to send, refusing anything that isn't a readable photo, video, document, contact card or audio file within the limit. */
export async function readSendableFile(path: string): Promise<SendableFile> {
    const resolved = resolveUserPath(path);
    // Open once and check what was opened, so the path can't be swapped between the check and the
    // read. O_NONBLOCK keeps a named pipe from blocking the open; it's refused as "not a file".
    let handle: FileHandle;
    try {
        handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
        throw unreadable(resolved, error);
    }
    let bytes: Buffer;
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new FileRefusedError(`Not sent: ${resolved} is not a file.`);
        if (info.size === 0) throw new FileRefusedError(`Not sent: ${resolved} is empty.`);
        if (info.size > MAX_FILE_BYTES) {
            throw new FileRefusedError("Not sent: the file is larger than 100 MiB, Blujay's limit for one attachment.");
        }
        bytes = await readExactly(handle, info.size, resolved);
    } catch (error) {
        throw error instanceof FileRefusedError ? error : unreadable(resolved, error);
    } finally {
        await handle.close().catch(() => undefined);
    }
    const type = detectFileType(bytes);
    if (!type) {
        throw new FileRefusedError(
            `Not sent: send_message can only send a photo, a video, a document (PDF, Word, Excel or PowerPoint), a contact card (vCard) or an audio file (as a voice memo), and ${basename(resolved)} is none of those.`,
        );
    }
    return {
        bytes,
        kind: type.kind,
        contentType: type.contentType,
        filename: sendName(resolved, type.extension),
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
