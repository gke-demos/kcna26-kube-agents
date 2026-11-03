// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// How signals look in the feed and the panel: an icon and a theme color per
// type (the scene's effect colors, so a feed line matches its animation).

/** Icon per signal type. */
export const SIGNAL_ICON = {
  alert: '!',
  triage: '⌕',
  triage_report: '≡',
  fix_chosen: '✓',
  pr_opened: '+',
  pr_merged: '⇥',
  pr_closed: '×',
  audit: '◎',
  chat: '›',
  action: '◆',
};

/** Short label per signal type (tooltips). */
export const SIGNAL_LABEL = {
  alert: 'Alert',
  triage: 'Triage',
  triage_report: 'Triage report',
  fix_chosen: 'Fix chosen',
  pr_opened: 'Pull request opened',
  pr_merged: 'Pull request merged',
  pr_closed: 'Pull request closed',
  audit: 'Audit',
  chat: 'Chat',
  action: 'Console action',
};

/** A signal type's color in a theme. */
export function signalColor(theme, sig) {
  const fx = theme.effects;
  switch (sig) {
    case 'alert':
      return fx.alert;
    case 'triage':
    case 'triage_report':
    case 'fix_chosen':
      return fx.triage;
    case 'pr_opened':
      return fx.pr;
    case 'pr_merged':
      return fx.merge;
    case 'pr_closed':
      return fx.removed;
    case 'action':
      return fx.action;
    case 'audit':
      return fx.beam;
    default:
      return theme.ui.evMeta;
  }
}
