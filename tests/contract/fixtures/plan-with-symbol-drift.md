# Test plan

## Task A1.1: Register a context block

**Files:**
- Modify: `src/store.ts` — call store.registerBlock(content)

- [ ] **Step 1: Write the call**

```ts
import { store } from './store.js';

export function makeBlock(content: string) {
  // store.ts defines `register(content)` but this plan calls `registerBlock(content)` — that's the drift.
  return store.registerBlock(content);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```
