// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/5/LICENSE

// Compact implementation of CodeMirror's simple mode addon. It covers the
// rule features used by the modes bundled with TwinPad (regex, token arrays,
// next/push/pop, sol and meta options).

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  CodeMirror.defineSimpleMode = function(name, states) {
    CodeMirror.defineMode(name, function(config) {
      return CodeMirror.simpleMode(config, states);
    });
  };

  CodeMirror.simpleMode = function(config, states) {
    ensureState(states, "start");
    var states_ = {}, meta = states.meta || {}, hasIndentation = false;
    for (var state in states) {
      if (state != "meta" && states.hasOwnProperty(state)) {
        var list = states_[state] = [], orig = states[state];
        for (var i = 0; i < orig.length; i++) {
          var data = orig[i];
          list.push(new Rule(data, states));
          if (data.indent || data.dedent) hasIndentation = true;
        }
      }
    }

    var mode = {
      startState: function() {
        return {state: "start", pending: null, local: null, localState: null,
                indent: hasIndentation ? [] : null};
      },
      copyState: function(state) {
        var s = {state: state.state, pending: state.pending,
                 local: state.local, localState: null,
                 indent: state.indent && state.indent.slice(0)};
        if (state.localState)
          s.localState = CodeMirror.copyState(state.local.mode, state.localState);
        if (state.stack) s.stack = state.stack.slice(0);
        return s;
      },
      token: tokenFunction(states_),
      innerMode: function(state) {
        return state.local && {mode: state.local.mode, state: state.localState};
      }
    };
    for (var prop in meta) if (meta.hasOwnProperty(prop))
      mode[prop] = meta[prop];
    return mode;
  };

  function ensureState(states, name) {
    if (!states.hasOwnProperty(name))
      throw new Error("Undefined state " + name + " in simple mode");
  }

  function toRegex(val) {
    if (!val) return /(?:)/;
    var flags = "";
    if (val instanceof RegExp) {
      if (val.ignoreCase) flags = "i";
      val = val.source;
    } else {
      val = String(val);
    }
    return new RegExp("^(?:" + val + ")", flags);
  }

  function asToken(val) {
    if (!val) return null;
    if (typeof val == "string") return val.replace(/\./g, " ");
    var result = [];
    for (var i = 0; i < val.length; i++)
      result.push(val[i] && val[i].replace(/\./g, " "));
    return result;
  }

  function Rule(data, states) {
    if (data.next || data.push) ensureState(states, data.next || data.push);
    this.regex = toRegex(data.regex);
    this.token = asToken(data.token);
    this.data = data;
  }

  // Consume the pending fragments of a multi-token match.
  function nextPending(stream, state) {
    while (state.pending && state.pending.length) {
      var part = state.pending.shift();
      if (!state.pending.length) state.pending = null;
      if (!part.text.length) continue;
      stream.pos += part.text.length;
      return part.token;
    }
    return null;
  }

  function tokenFunction(states) {
    return function(stream, state) {
      if (state.pending) return nextPending(stream, state);

      if (state.local) {
        if (state.local.end && state.local.end.test(stream.string.slice(stream.pos))) {
          state.local = state.localState = null;
          return null;
        }
        return state.local.mode.token(stream, state.localState);
      }

      var curState = states[state.state];
      for (var guard = 0; guard < 200; guard++) {
        var matched = false;
        for (var i = 0; i < curState.length; i++) {
          var rule = curState[i];
          if (rule.data.sol && !stream.sol()) continue;
          var matches = stream.match(rule.regex, false);
          if (!matches) continue;
          matched = true;

          // State transitions first, so zero-width rules can chain.
          if (rule.data.next) {
            state.state = rule.data.next;
            curState = states[state.state];
          } else if (rule.data.push) {
            (state.stack || (state.stack = [])).push(state.state);
            state.state = rule.data.push;
            curState = states[state.state];
          } else if (rule.data.pop && state.stack && state.stack.length) {
            state.state = state.stack.pop();
            curState = states[state.state];
          }

          if (rule.data.mode) {
            state.local = {mode: rule.data.mode, end: rule.data.end || null};
            state.localState = CodeMirror.startState(rule.data.mode);
          }

          var token = rule.token;
          if (typeof token == "function") {
            stream.pos += matches[0].length;
            token = token(stream, state);
            if (token == null) token = "";
            return token;
          }

          if (!token) {
            stream.pos += matches[0].length;
            if (matches[0].length) return null;
            // Zero-length rule (state transition only): continue scanning.
            continue;
          }

          if (typeof token == "string") {
            stream.pos += matches[0].length;
            return matches[0].length ? token : null;
          }

          // Token array: split the match along its capture groups.
          var parts = [], cursor = 0;
          for (var g = 0; g < token.length; g++) {
            var text = matches[g + 1];
            if (text == null) text = "";
            if (g === 0) {
              // Text before the first group inherits the first token.
              var gap = matches[0].indexOf(text);
              if (gap > 0) parts.push({text: matches[0].slice(0, gap), token: token[0]});
            }
            if (text) parts.push({text: text, token: token[g]});
            cursor += text.length;
          }
          var tail = matches[0].length - cursor;
          if (tail > 0) parts.push({text: matches[0].slice(matches[0].length - tail), token: token[0]});

          if (!parts.length) {
            stream.pos += matches[0].length;
            return matches[0].length ? token[0] : null;
          }
          state.pending = parts;
          return nextPending(stream, state);
        }
        if (!matched) {
          stream.next();
          return null;
        }
        // A zero-width rule matched and changed state; try the new state.
      }
      stream.next();
      return null;
    };
  }
});
