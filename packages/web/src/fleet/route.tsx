/**
 * Screens 1 and 2 registration.  TRACK B.
 * Reserved slots: order 10 hotkey `1` (Fleet), order 20 hotkey `2` (Project).
 *
 * Both are registered from here using the plural `screens` export added in
 * Amendment 7. Before that existed this directory had to be accompanied by a
 * `src/project/` holding a three-line re-export, purely so the one-screen-per-
 * directory glob could see the second one.
 */

import type { ScreenDef } from '../lib/screens.js';
import { Fleet } from './fleet.js';
import { ProjectScreen } from './project.js';

export const screens: ScreenDef[] = [
  { id: 'fleet', label: 'Fleet', hotkey: '1', order: 10, Component: Fleet },
  { id: 'project', label: 'Project', hotkey: '2', order: 20, Component: ProjectScreen },
];
