import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerObserver } from './observer.mjs';

export default definePluginEntry({
  id: 'openclaw-token-governor',
  name: 'Token Governor Observer',
  description: 'Local attempt-aggregate usage observer; no request gate or context engine.',
  register(api) { registerObserver(api); },
});
