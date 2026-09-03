# cabra web client

React + TypeScript (Vite) browser client for a cabra host. See
[`../docs/web.md`](../docs/web.md) for what it does and how it is served.

```
npm ci
npm run build     # -> dist/, served by `cabra host --web dist`
npm test          # protocol client tests (vitest)
npm run dev       # dev server, proxies /ws to 127.0.0.1:8850
```

`src/protocol/client.ts` is the DOM-free protocol state machine (the
tested part); `src/App.tsx` is the UI over it.
