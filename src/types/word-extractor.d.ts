declare module 'word-extractor' {
  class Document {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
    getFootnotes(): string;
    getEndnotes(): string;
  }
  class WordExtractor {
    extract(input: Buffer | string): Promise<Document>;
  }
  export = WordExtractor;
}
