// Searches the Blujay docs (docs.blujay.io/llms-full.txt, loaded once per session).
const DOCS_URL = "https://docs.blujay.io/llms-full.txt";

interface Page {
    title: string;
    url: string;
    body: string;
}

let pages: Promise<Page[]> | null = null;

function parse(text: string): Page[] {
    return text
        .split(/\n(?=# )/)
        .map((chunk) => {
            const [heading = "", source = "", ...rest] = chunk.split("\n");
            return {
                title: heading.replace(/^# /, "").trim(),
                url: source.replace(/^Source: /, "").trim(),
                body: rest.join("\n").trim(),
            };
        })
        .filter((page) => page.title && page.url.startsWith("http"));
}

export function loadDocs(fetchFn: typeof fetch = fetch): Promise<Page[]> {
    pages ??= fetchFn(DOCS_URL)
        .then((response) => {
            if (!response.ok) throw new Error(`docs.blujay.io returned ${response.status}`);
            return response.text();
        })
        .then(parse)
        .catch((error) => {
            pages = null; // try again next time
            throw error;
        });
    return pages;
}

export async function searchDocs(query: string, fetchFn: typeof fetch = fetch, maxResults = 3): Promise<string> {
    const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
    if (!terms.length) return "Add a few words to search for.";
    const scored = (await loadDocs(fetchFn))
        .map((page) => {
            const title = page.title.toLowerCase();
            const body = page.body.toLowerCase();
            let score = 0;
            for (const term of terms) {
                if (title.includes(term)) score += 10;
                score += Math.min(body.split(term).length - 1, 10);
            }
            // Guides explain; reference pages list fields. Prefer guides when they tie.
            if (!page.url.includes("/api-reference/")) score += 0.5;
            return { page, score };
        })
        .filter((result) => result.score > 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    if (!scored.length) return `Nothing in the docs matched "${query}". Browse https://docs.blujay.io.`;
    return scored
        .map(({ page }) => {
            const excerpt = page.body.length > 2500 ? `${page.body.slice(0, 2500)}\n…` : page.body;
            return `# ${page.title}\n${page.url}\n\n${excerpt}`;
        })
        .join("\n\n---\n\n");
}
