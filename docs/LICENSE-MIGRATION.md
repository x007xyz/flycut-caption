# Custom community / commercial licensing migration record

Prepared: 2026-10-27. Status: local working-tree change; no GitHub push, npm publication, signed customer license, or release has been performed as part of this change.

## Scope

The project owner subsequently required **no renaming** and **a separate paid commercial license for closed-source integration**. The initial standard AGPL proposal has therefore been replaced with the **FlyCut Caption Community Source License 1.0**, a custom source-available license. No release was made by this change.

Standard AGPL section 7 permits removal of further restrictions outside its allowed categories. A blanket no-renaming condition must not be represented as a removable addition to standard AGPL. The current license is self-contained, does not incorporate AGPL and is not represented as OSI-approved. Reference: https://opensource.org/license/agpl-3.0 (sections 7 and 10).

The custom community license requires retaining FlyCut Caption identity, sharing source for distributions and modified network-accessible versions, and a prior written commercial agreement for closed-source integration, including applicable private integrations. Buying integration permission does not automatically permit renaming. Media outputs and independent API/CLI/MCP consumers are distinguished from covered code integrations.

npm and component metadata use `SEE LICENSE IN LICENSE`; Cargo manifests use a relative `license-file`. No standard AGPL grant or invented SPDX commercial alternative is declared. A commercial agreement is not a public permission to choose unspecified proprietary terms.

Name retention and source availability are in the custom LICENSE itself, not only a brand policy. The brand policy does not claim trademark law alone prevents renaming. The English LICENSE controls; summaries must not create contrary grants.

The existing root LICENSE is archived at `licenses/legacy/LICENSE-before-agpl.txt`. That archive documents the previous custom MIT-plus-branding text; it is not an alternative grant for current code. Old copies and releases retain their original terms. The current package version remains the unpublished working-tree base version; select a new version and communicate the license change before any release. Do not overwrite or describe an existing published 2.0.2 artifact as relicensed.

## Rights review still required before publication or customer grants

Static Git history review found these author identities at base commit `ad00f06`:

| Identity | Commits | Review status |
|---|---:|---|
| `zhangxiang.chen-EFWOM <1026161550@qq.com>` | 46 | Owner-associated identity; Git identity alone does not establish chain of title |
| `x007xyz <1026161550@qq.com>` | 1 | Owner identified this account as their own in the planning conversation |
| `google-labs-jules[bot]` | 1 | Provenance and applicable generation/service terms not verified |

The bot commit is `03ea7c6edbadd018cfec9358cac8128129273897`, concerning i18n and these paths:

- `src/FlyCutCaption.tsx`
- `src/locales/en_US.ts`
- `src/locales/index.ts`
- `src/locales/types.ts`
- `src/locales/zh_CN.ts`

Do not infer a third-party copyright claim merely from a bot author, or infer commercial relicensing permission from a Git commit. Verify the owner-initiated workflow, the terms applicable to that generation, and any copied material. For any actual external rights, obtain sufficient permission or exclude/replace the affected portions before offering rights you do not control.

Also inventory incorporated code, dependencies, fonts, models, and distributed FFmpeg binaries. This change does not relicense any of them or certify their compatibility. Preserve their existing notices and satisfy their distribution requirements.

## Release checklist

- [ ] Resolve and record first-party rights and the bot contribution's provenance; obtain any required permissions.
- [ ] Inventory third-party code/assets and confirm compatibility for custom community and intended commercial distributions. In particular, do not impose this custom license's extra restrictions on third-party material whose existing license forbids them.
- [ ] Have qualified counsel review the custom license for intended jurisdictions, including name retention, covered integrations, termination and enforceability. This change does not certify legal enforceability.
- [ ] Review the customer commercial agreement with the actual contracting entity and rights scope; this repository contains only a commercial-licensing notice.
- [ ] Choose a new release version consistently across npm, component version exports, Cargo and Tauri; communicate the change to existing component users.
- [ ] Check packaged npm/desktop artifacts contain the license and licensing notices, and any third-party notices required for that artifact.
- [ ] For binaries, provide the Corresponding Source for the exact released revision and required build/install instructions as required by custom LICENSE section 4.
- [ ] For modified network-accessible versions, prominently offer their Corresponding Source to remote users as required by custom LICENSE section 4; an unrelated or older upstream link is insufficient.
- [ ] Preserve FlyCut Caption identity in covered interfaces/documentation and identify unofficial versions/operators; do not add a conflicting general permission to rename.
- [ ] Review the relevant application's legal notices and source links before public distribution/deployment. Verify offline notice accessibility for desktop bundles.
- [ ] Record version, commit, source location, licensing exceptions, and archived artifact notices in release notes.

The existing release automation has not been changed to push or publish anything. This record is an explicit release-readiness checklist, not confirmation that those tasks are complete.
