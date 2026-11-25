/**
 * BM25 (fork, owner 2026-11-24): the one tokenizer and term score shared by
 * the proposition candidates (proposition-candidates.ts) and the bookshelf
 * search (books.ts). Standard k1 = 1.2, b = 0.75; each caller brings its
 * own stop words and decides what a "document" is.
 */

/** Unicode words, NFKC-folded and lowercased, minus the caller's stop words. */
export function bm25Words(text: string, stopWords: ReadonlySet<string>): string[] {
	return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
		.filter((word) => !stopWords.has(word));
}

/** One query term's BM25 contribution to one document. */
export function bm25TermScore(tf: number, df: number, documents: number, length: number, averageLength: number): number {
	const idf = Math.log(1 + (documents - df + 0.5) / (df + 0.5));
	return idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length / averageLength));
}
