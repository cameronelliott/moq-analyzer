// This site's bundle entry. A page loads it with one script tag.

import { configureCharts } from '../lib/chart-element.js';

// The import() literal stays here rather than in lib/, which is what keeps
// ECharts in its own chunk instead of the entry.
configureCharts(() => import('./charts.js'));
