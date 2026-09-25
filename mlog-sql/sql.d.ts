// The .sql files are imported as text (`with { type: "text" }`), which Bun
// supports at runtime and in its bundler. This tells tsc what that import is.
declare module "*.sql" {
    const text: string;
    export default text;
}
