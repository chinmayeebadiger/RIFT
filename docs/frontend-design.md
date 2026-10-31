# Website audit workspace

The primary user is a website owner reviewing what broke and how Rift would repair it. The main job is to move from a website address to understandable findings and an inspectable fix.

## Design plan

- Canvas `#F6F7FB`, paper `#FFFFFF`, graphite `#242633`, iris `#5855D6`, error `#BE344A`, success `#23775C`.
- Locally served Manrope for the interface; system monospace only for actual source code and URLs.
- Left-aligned working surface, compact fixed navigation, a single website input, then a master-detail report. Severity has both a text label and an icon; color is supplemental.
- The memorable element is an annotated, interactive storefront that becomes a before-and-after repair demonstration. Borders establish grouping; shadows are reserved for the modal.

```text
navigation | workspace breadcrumb                        export
           | Website scanner
           | [ website URL __________________ ] [Scan website]
           | report identity       severity summary
           | [filter tabs________] | [website / issue details]
           | issue + severity      | browser preview
           | issue + severity      | explanation + Resolve
```

An alternative full-width report table makes severity easy to scan, but separates each finding from its visible effect. The split workspace makes selection and repair the central interaction.

## Review before implementation

Removed the proposed marketing hero and repeated metric cards: neither helps someone inspect a broken website. Use one compact summary strip and a real input instead. Reserve iris for selection and actions, not decorative gradients. The storefront uses its own pale blue product illustration, so the audit surface stays quiet.

## Behavior and scope

- The initial report is explicitly a sample, with six illustrative findings and interactive fix previews.
- Public URLs run bounded server-side HTML checks. Results identify actual returned markup; they do not imply browser execution, exhaustive bug discovery, or automatic deployment.
- Resolve shows the observed issue, suggested change, and preview. Sample interaction previews are labelled demonstrations. External-site changes are suggestions for review, with no fabricated fixed-page rendering.
- Report export, finding filters, search, rescan, keyboard operation, responsive layouts, and error/retry states are functional.
- Existing incident, evidence, patch, and approval routes remain available from the recovery workspace.
