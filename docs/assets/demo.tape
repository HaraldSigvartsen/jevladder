# Regenerate from repo root after `pnpm run build`: vhs docs/assets/demo.tape
Output docs/assets/demo.gif

Require node

Set Shell bash
Set FontSize 13
Set Width 900
Set Height 500
Set Theme "Catppuccin Mocha"
Set Padding 16
Set Margin 8
Set MarginFill "#1a1b1e"
Set TypingSpeed 30ms
Set PlaybackSpeed 1.0

Env PS1 "$ "
Env JEVLADDER_TYPESAFE_API_KEY ""
Env TYPESAFE_API_KEY ""
Env JEVLADDER_JUDGE_API_KEY ""

Hide
Type "unset JEVLADDER_TYPESAFE_API_KEY TYPESAFE_API_KEY JEVLADDER_JUDGE_API_KEY 2>/dev/null; alias jevladder='node dist/src/cli.js'; clear"
Enter
Sleep 300ms
Show

Type "jevladder check --diff examples/merge-gate/sample.diff --tests-passed"
Enter
Wait+Screen /outcome:/
Sleep 800ms
Type "echo $?"
Enter
Sleep 3s

Type "jevladder check --diff examples/merge-gate/sample-risky.diff --tests-passed"
Enter
Wait+Screen /outcome:/
Sleep 800ms
Type "echo $?"
Enter
Sleep 3s

Type 'jevladder route --explain "Migrate the payments database in production"'
Enter
Wait+Screen /explanation:/
Sleep 3s
