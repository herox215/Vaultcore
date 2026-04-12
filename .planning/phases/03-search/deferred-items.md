## Pre-existing TypeScript errors in tabStore.ts (discovered during 03-02)

These errors existed before Plan 03-02 and are out of scope:
- src/store/tabStore.ts(149,13): `string | undefined` not assignable to `string | null`
- src/store/tabStore.ts(153,13): same pattern
- src/store/tabStore.ts(157,13): same pattern
- src/store/tabStore.ts(190,19): Updater type mismatch
- src/store/tabStore.test.ts(38,14): Object possibly undefined
- src/store/tabStore.test.ts(39,14): Object possibly undefined

Root cause: tabStore uses array `.find()` which returns `T | undefined`, but Tab fields are typed as `string | null`.
