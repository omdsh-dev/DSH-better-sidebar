// Build the frame from the resolved dependency graph, not Mermaid's prebuilt
// UMD (which embeds its own KaTeX and bypasses consumer security overrides).
export { default } from 'mermaid'
