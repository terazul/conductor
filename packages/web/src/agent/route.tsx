/**
 * Screen 3 registration.  TRACK B.
 * Reserved slot: order 30, hotkey `3` (lib/screens.ts).
 */

import type { ScreenDef } from '../lib/screens.js';
import { AgentScreen } from './agent.js';

export const screen: ScreenDef = {
  id: 'agent',
  label: 'Agent',
  hotkey: '3',
  order: 30,
  Component: AgentScreen,
};
