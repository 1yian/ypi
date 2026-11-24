import { Box, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { ModelChoice } from './compactor.ts';
import { count, oneLine } from './inspector.ts';
import { frame, showModel } from './settings-page.ts';

/** What `/optchat` offers, in menu order; each is also `/optchat <action>`. */
export const ACTIONS = ['profile', 'settings', 'model', 'agents', 'usage', 'activity', 'instructions', 'browse', 'import'] as const;
export type MenuAction = typeof ACTIONS[number];
const DESCRIPTIONS: Record<MenuAction, string> = {
  profile: 'Switch or create a profile',
  settings: 'Models, subagent limits, memory options',
  model: 'Compactor model and effort',
  agents: 'Live agent tree and saved runs',
  usage: 'Token usage and cost estimates',
  activity: 'Memory gauge and running agents',
  instructions: 'Edit this profile\'s AGENTS.md',
  browse: 'Open a readable snapshot of memory',
  import: 'Import history, or resume a paused import',
};

export interface MenuStatus { profile: string; messages: number; pending: number; compactor: ModelChoice; agents?: ModelChoice; error?: string }
/** The status block as label and value; the plain menu outside the TUI shows the same rows. */
export const statusRows = (s: MenuStatus) => [
  ['Memory', `${count(s.messages)} messages · ${count(s.pending)} pending`],
  // config.json only checks these are strings, so one with a newline or escape code must not break the block.
  ['Compactor', oneLine(showModel(s.compactor))],
  ...(s.agents ? [['Agents', oneLine(showModel(s.agents))] as const] : []),
] as const;
const failing = (error: string) => `Summaries failing: ${oneLine(error)}`;

/** Framed like the settings page: title, the profile's status as aligned rows, then the actions with what each opens. */
export function optchatMenu(theme: Theme, title: string, status: MenuStatus | undefined, close: (action?: MenuAction) => void, redraw = () => {}, subagents = true) {
  const actions = subagents ? [...ACTIONS] : ACTIONS.filter(action => action !== 'agents');
  const describe = (action: MenuAction) => !subagents && action === 'settings' ? 'Compactor model and memory options'
    : !subagents && action === 'activity' ? 'Memory gauge and summary progress' : DESCRIPTIONS[action];
  const list = new SelectList(actions.map(value => ({ value, label: value, description: describe(value) })), actions.length, {
    selectedPrefix: t => theme.fg('accent', t), selectedText: t => theme.fg('accent', t),
    description: t => theme.fg('muted', t), scrollInfo: t => theme.fg('muted', t), noMatch: t => theme.fg('muted', t) },
    { minPrimaryColumnWidth: 1, maxPrimaryColumnWidth: Math.max(...actions.map(a => a.length)) + 4 });
  list.onSelect = item => close(actions.find(a => a === item.value));
  list.onCancel = () => close();
  const rows = status ? statusRows(status) : [];
  const labels = Math.max(0, ...rows.map(([label]) => label.length));
  const facts = status ? rows.map(([label, value]) => new Text(`${theme.fg('muted', label.padEnd(labels))}  ${value}`, 1, 0)) : [new Text(theme.fg('muted', 'No active profile'), 1, 0)];
  if (status?.error) facts.push(new Text(theme.fg('warning', failing(status.error)), 1, 0));
  const actionsBox = new Box(1, 0); actionsBox.addChild(list);
  const page = frame(theme, title, status?.profile, [new Spacer(1), ...facts, new Spacer(1), actionsBox, new Spacer(1),
    new Text(theme.fg('dim', '↑↓ select · Enter open · Esc close'), 1, 0)]);
  return Object.assign(page, { handleInput: (data: string) => {
    // j and k move too, as in Pi's own select dialog that this menu replaces.
    const step = data === 'j' ? 1 : data === 'k' ? -1 : 0, at = actions.findIndex(a => a === list.getSelectedItem()?.value);
    if (step) list.setSelectedIndex(Math.max(0, Math.min(actions.length - 1, at + step)));
    else list.handleInput(data);
    redraw();
  } });
}

/** The menu in interactive Pi; elsewhere (RPC hosts) Pi's plain select with the same facts and actions. */
export function showMenu(ctx: ExtensionContext, title: string, status: MenuStatus | undefined, subagents = true): Promise<MenuAction | undefined> {
  if (ctx.mode === 'tui') return ctx.ui.custom<MenuAction | undefined>((tui, theme, _keys, done) => optchatMenu(theme, title, status, done, () => tui.requestRender(), subagents));
  const actions = subagents ? [...ACTIONS] : ACTIONS.filter(action => action !== 'agents');
  const facts = status ? [status.profile, ...statusRows(status).map(([label, value]) => `${label}: ${value}`), ...status.error ? [failing(status.error)] : []] : ['No active profile'];
  return ctx.ui.select([title, ...facts].join('\n'), actions).then(choice => actions.find(a => a === choice));
}
