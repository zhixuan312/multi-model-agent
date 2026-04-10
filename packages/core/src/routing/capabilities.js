"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBaseCapabilities = getBaseCapabilities;
var FILE_CAPABILITIES = ['file_read', 'file_write', 'grep', 'glob'];
function getBaseCapabilities(config) {
    var _a, _b;
    var caps = __spreadArray([], FILE_CAPABILITIES, true);
    if (config.sandboxPolicy === 'none') {
        caps.push('shell');
    }
    switch (config.type) {
        case 'codex': {
            var hosted = (_a = config.hostedTools) !== null && _a !== void 0 ? _a : ['web_search'];
            if (hosted.includes('web_search'))
                caps.push('web_search');
            break;
        }
        case 'claude': {
            caps.push('web_search', 'web_fetch');
            break;
        }
        case 'openai-compatible': {
            if (((_b = config.hostedTools) !== null && _b !== void 0 ? _b : []).includes('web_search'))
                caps.push('web_search');
            break;
        }
    }
    return Array.from(new Set(caps));
}
