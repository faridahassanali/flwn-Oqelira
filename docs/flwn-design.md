# Flwn design integration.

The UI uses the official [Flwn Design skill](https://github.com/a-elhaag/flwn-design)
at commit `ab5da1bd7ca94ff5ec8d2cf47fd6945ca0adbc35`. Its complete source is vendored
in `.agents/skills/flwn-design`, including the palette reference and original logos.
No workflow or GitHub Actions permission changes were needed to use the skill.

`packages/ui/src/tokens.css` is copied verbatim from its palette source. Runtime
colors reference those tokens. Logos and browser icons are copied unchanged;
the gold favicon is used only as the browser/app icon, never as a header logo.

The UI self-hosts Plus Jakarta Sans and JetBrains Mono and uses Lucide exclusively.
Layout/type/spacing use rem; hairlines and canvas dots retain px. The shared
renderer serves both Web and Desktop, including account and project screens.

The coding workspace keeps its conversation, explorer, tools and detail panels.
Secondary navigation is grouped under Tools so the primary rail stays compact.
Motion uses the skill's timing/easing tokens with reduced-motion support.

For an update, compare the pinned source against upstream, copy the skill and
tokens/assets from the same revision, and visually verify the affected screens.
Do not silently recolor or redraw a logo or add new accent colors.

Validation: UI and Web TypeScript checks and production build pass. Host/server
integration tests pass (12 tests). Browser review covers desktop and mobile,
account creation, projects, memory saving, streaming and file approval, using
temporary local data and a mock model without Foundry usage or Azure resources.
