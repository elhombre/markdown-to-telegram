# Product Notes for Friday

This is a plain text fixture with no media.

It exercises headings, paragraphs, bold text, italic text, links, lists, quotes, and fenced code blocks without involving any media planning rules.

## Highlights

- The parser should detect `mediaPosition: none`.
- The renderer should produce one HTML body.
- The planner should emit a single message step.

> Keep this fixture simple enough to inspect by eye and rich enough to cover the common formatting rules.

```ts
console.log('text-only fixture');
```
