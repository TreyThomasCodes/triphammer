# Credits

Triphammer adapts code and ideas from these projects, each used under the MIT License.

| In Triphammer | From |
| --- | --- |
| `plugins/triphammer/hooks/agent-guard.py`: the tracked-file and shell-edit-target detection and the heredoc-is-prose rule | `guard.py` in [rezk2ll/skills](https://github.com/rezk2ll/skills) (`plugins/guard/scripts/guard.py`, commit bf99b4b) |
| `plugins/triphammer/hooks/text-lint.py`: the upstream rules, the text extraction and the missing `--body-file` refusal | `text-lint.py` in [rezk2ll/skills](https://github.com/rezk2ll/skills) (`plugins/text-lint/scripts/text-lint.py`, commit bf99b4b) |
| The `triphammer:upkeep` skill | the `gardener` skill in [rezk2ll/skills](https://github.com/rezk2ll/skills) (`plugins/gardener`) |
| The builders' rule to reuse what exists before writing a mechanism (`plugins/triphammer/agents/builder.md`, `builder-light.md`) | the `ponytail` skill in [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (`skills/ponytail`) |

The two hooks also carry their notice in their headers, next to the adapted code.

Skills and agents keep their credit here rather than in their own text, because a session loads that text into its
context on every run.

## Licenses

rezk2ll/skills:

```text
Copyright (c) 2026 Khaled Ferjani
```

DietrichGebert/ponytail:

```text
Copyright (c) 2026 DietrichGebert
```

Both are under the MIT License:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
