/**
 * SidebarPanel marks its session, panel and expanded state; retained SessionView
 * ancestors carry `hidden` (SDK ui-sidebar-right). Never infer activity from a
 * tab id: ids are only session-local. Unknown/ambiguous surfaces fail closed.
 */
export function visibleNativePanel(doc: Document): HTMLElement | undefined {
  const panels = [...doc.querySelectorAll<HTMLElement>('[data-sidebar-right-panel][data-sidebar-right-session][data-sidebar-right-open]')]
    .filter(panel => {
      if (panel.getAttribute('data-sidebar-right-session') === '') return false
      for (let node: HTMLElement | null = panel; node !== null; node = node.parentElement) {
        if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false
        const style = doc.defaultView?.getComputedStyle(node)
        if (style?.display === 'none' || style?.visibility === 'hidden') return false
      }
      return true
    })
  return panels.length === 1 ? panels[0] : undefined
}
