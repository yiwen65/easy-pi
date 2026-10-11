# Public model catalog tools

The public catalog remains schema version **1**. A generated bundle contains:

| File | Contents |
| --- | --- |
| `models.json` | Provider-keyed, ID-keyed **chat** models |
| `providers.json` | Sorted provider IDs, including image-only providers |
| `providers/<provider>.json` | ID-keyed chat models; `{}` for image-only providers |
| `models.all.json` | Array of all chat and image models |
| `providers/<provider>.all.json` | Array of that provider's chat and image models |

Mixed records require an explicit `type: "chat"` or `type: "image"`.
Identity is `(provider, type, id)`: chat and image records may share an ID without
replacing each other. Legacy keyed chat records may omit `type`.

## Validate without publishing

```sh
node scripts/publish-model-catalog.mjs --input /tmp/catalog --dry-run
```

This command reads local files and writes `/tmp/catalog/publication.json`; it
never invokes AWS. Use a disposable copy if the input must remain unchanged.
Validation requires both projections and every provider shard, matching complete
metadata, provider membership, and chat projection. It rejects unknown operation
types, malformed IDs/providers, duplicate operations, and missing/extra shards.
The existing completeness guards still require Anthropic, OpenAI, OpenRouter,
and at least 500 **chat** models. Images cannot satisfy that minimum.

`publication.json` and new `index.json` entries retain `modelCount` as the legacy
chat count. `imageModelCount` and `totalModelCount` are additive fields;
`providerCount` counts the full provider list.

The revision hashes the sorted relative filenames and exact bytes of **all**
validated catalog files, not just `models.json`. Every image field contributes;
image-only edits change the revision. Formatting also changes it. Publication
metadata/timestamps are not part of the hash.

## Immutable publication archive

The publisher uploads both projections and `providers.json` beneath
`models/v1/revisions/<revision>/`, with immutable caching, then uploads
`models/v1/index.json` **last**, with `no-store`. An upload failure cannot advance
the index. Other minimum-client-version entries and their count metadata are
preserved. Schema version and minimum client version are unchanged.

Publishing requires explicit `--bucket` and `--endpoint` arguments and AWS
configuration; it is not a dry-run. The node tests substitute a temporary mock
`aws` executable and never contact storage. There is no separate public-catalog
archive script; the immutable revision objects are the catalog archive. The
release source archive is a separate tool, not a public JSON catalog bundle.

## Offline comparisons

```sh
node scripts/diff-model-catalog.mjs --before /tmp/before --after /tmp/after
node scripts/diff-model-catalog.mjs --before /tmp/before --after /tmp/after openrouter
node scripts/diff-model-catalog.mjs --thinking --before /tmp/before --after /tmp/after
```

Both paths must be supplied together. This mode reads pre-generated bundles,
uses temporary diff snapshots, and never creates a git worktree or runs the
model generator. It works outside a git repository and leaves inputs unchanged.
It still uses local `git diff --no-index` to render changed lines.

The default comparison covers all operation types and labels changes as
`<provider>/<type>:<id>`. Legacy-only bundles without `models.all.json` and mixed
shards can be compared as chat-only; their missing chat type is normalized for
comparison, not treated as an edit. A partially present mixed projection fails
validation instead of silently falling back to chat-only input.

`--thinking` compares **chat only**, using the existing thinking-capability
helper. In offline mode both catalogs use the current implementation. Without
`--before`/`--after`, the existing HEAD/current-worktree mode generates catalogs
using network inputs and computes thinking capabilities with each worktree's
implementation. `PI_OFFLINE=1` alone does not select pre-generated inputs; use the
explicit paths for a fully offline comparison.

Targeted tests:

```sh
node --test scripts/publish-model-catalog.test.mjs scripts/diff-model-catalog.test.mjs
```
