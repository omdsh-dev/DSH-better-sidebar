# Contributors

dsh-better-sidebar is built with the community. This file records the PR authors of the current unreleased cycle; the release note repeats this table.

> **Commit attribution.** Contributor PRs keep their original git author. The integration merge commit and maintainer fixups are authored by the maintainer. Starting with this cycle, contributor PRs are rebased onto `dev` and fast-forwarded where possible, so contributor commits stay in the first-parent history instead of living only under a merge commit.

| Contributor | Contribution | PR |
| --- | --- | --- |
| @yanzhaohui1999 | Mermaid zoom only scales the diagram; nested Markdown code-region masks; the file tree search header joins the session tab rule | [#829](https://github.com/omdsh-dev/DSH-better-sidebar/pull/829), [#1154](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1154), [#1011](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1011) |
| @chenkai2 | agent-opens heartbeat and reconnect | [#954](https://github.com/omdsh-dev/DSH-better-sidebar/pull/954) |
| @laozhong86 | Relative file links resolve from the session cwd | [#963](https://github.com/omdsh-dev/DSH-better-sidebar/pull/963) |
| @lq-kiren | Task labels stay consistent with the board | [#1026](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1026) |
| @seudut | Markdown preview images resolve on the page base | [#1043](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1043) |
| @jerryzmtz | Native single-page tab titles follow the registry | [#1108](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1108) |
| @BBleae | Restored drafts keep their mtime baseline; same-origin quote records no longer overwrite each other | [#1131](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1131), [#1132](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1132) |
| @UNscientific-9 | Data-safety audit: literal pathspecs, archive option fencing, save races, CAS, release dry-run | [#1146](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1146) |
| @PerryLink | Tasks re-read optional services per request; side-chat model-selection notice | [#1149](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1149), [#1152](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1152) |
| @NolanHo | Side-chat alignment with the main pane: fork point, windowed transcript, composer guards, per-thread drafts, attachments, work-details rows | [#1147](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1147) |
| @feigo313 | Built-in audio/video preview and HTTP Range on the file route | [#1027](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1027) |
| @evgyur | Preview sandbox hardening, archive capacity, bundled KaTeX security update | [#1123](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1123) |
| @stallenlu | Run git inside the WSL distribution for `\\wsl.localhost` workspaces | [#1135](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1135) |
| @majt415 / @lu.wang7 | External `fileActions` and editor-header `tabActions` | [#1137](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1137) |
| @gardenerHan | Declare `@deepseek-ai/schemastery` as a peer dependency | [#1156](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1156) |
| @pennxiang | Side-chat page mode: shared default plus independent per-thread native pages with exact bindings | [#1115](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1115) |
| @iasiv5 | Responsive multi-repo switcher with location labels | [#1130](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1130) |
| @wang-kaopu | Clickable absolute Markdown paths in chat | [#882](https://github.com/omdsh-dev/DSH-better-sidebar/pull/882) |
| @llwinty | WSL repository roots keep their UNC spelling, so the Git tab loads | [#1206](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1206) |

| @WinterXMQ | The bottom workbench collapses itself while the right panel is fullscreen | [#1233](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1233) |
| @hairyf | Native tab icons match the host title geometry; the task-graph view switch is square | [#945](https://github.com/omdsh-dev/DSH-better-sidebar/pull/945), [#948](https://github.com/omdsh-dev/DSH-better-sidebar/pull/948) |
| @Henvy-Mango | The back-to-latest pill keeps its content height and round ends | [#1209](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1209) |
| @Crisy1084 | `admit` runs inside the injected `connection.authentication` fiber, so `/sidebar/*` works on DSH 0.2.3 | [#1248](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1248) |
| @lucagiftzek | Catalog: five tab plugins (artifacts, conductor, mail, phone, voice) | [#1162](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1162) |
| @CCColastic | Catalog: Session Sources | [#1105](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1105) |
| @shuuul | Catalog: dsh-bioviewer | [#1091](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1091) |
| @vlln | Catalog: dsh-pr-inbox | [#984](https://github.com/omdsh-dev/DSH-better-sidebar/pull/984) |
| @hudsonhou | Catalog: dsh-zotero-workspace | [#1140](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1140) |
| @ionaryu | Catalog: dsh-copy-document | [#1054](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1054) |
| @lpf20200901 | Catalog: dsh-memory-delta pin | [#957](https://github.com/omdsh-dev/DSH-better-sidebar/pull/957) |
| @kp-z | Catalog: dsh-dev-git-graph repository URL | [#1184](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1184) |
| @g-yixuan | Sidenote catalog copy and install notes | [#1187](https://github.com/omdsh-dev/DSH-better-sidebar/pull/1187) |

Maintainer-authored work in the same cycle (issue implementations, fixes, integration and tests) is recorded in the changelog. Add a row here when integrating a contributor PR; the release note is the authoritative, versioned copy.
