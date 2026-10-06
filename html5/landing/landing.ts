// The landing page's bundle entry. landing/index.html loads it with one
// script tag.
//
// The page once took Web Awesome from its CDN: 97 requests, and no styles or
// buttons without a network. These are the wa-* elements it uses, from the same
// package as the analyzer. wa-page draws a menu button with wa-icon.

import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { useLocalIcons } from '../lib/local-icons';

useLocalIcons();
