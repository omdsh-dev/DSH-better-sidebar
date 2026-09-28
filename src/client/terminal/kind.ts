/**
 * 底部工作台的终端 tab 类型 id。
 *
 * 与宿主右侧栏的 `terminal` kind **同名**，但两者互不干涉：宿主在
 * `sidebarRightTabs` 里已经注册了它自己的 `terminal` 实现，本插件的这个类型
 * 只注册进插件自己的注册表（`bottomOnly`，见 service.ts），不产生原生类型、也
 * 不进宿主的 guide——否则选择器/guide 里会出现第二条 terminal 条目（仓库的
 * 挂载 e2e 正是钉这条边界）。
 */
export const TERMINAL_KIND = 'terminal'
