# Kreative Krew demo, recorded with vhs (https://github.com/charmbracelet/vhs)
# Uses /krew-demo, so nothing real runs and no worker is hired.
# Record from the repo root:  vhs demo/demo.tape

Output demo/kreative-krew.mp4
Output demo/kreative-krew.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1760
Set Height 1240
Set Padding 18
Set Margin 30
Set MarginFill "#11111b"
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set PlaybackSpeed 1.0
Set Framerate 24

Hide
Type "cd /tmp/krew-demo-app && unset $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_]*' | tr '\n' ' ') && clear"
Enter
Sleep 500ms
Show

Type "claude"
Enter
Sleep 8s
# accept the folder-trust dialog ("Yes, I trust this folder" is the second option)
Down
Sleep 500ms
Enter
Sleep 6s

Type "/krew-lead"
Enter
Sleep 4s

Type "/krew-demo"
Enter
Sleep 6s

# the inbox: a brief waiting for approval, a proposed rotation, a drafted reply
Type "d"
Sleep 4s

# approve the brief: Pixel is hired
Type "a"
Sleep 4s

# send the pre-drafted answer to Nova
Type "s"
Sleep 3s

# tour the tabs
Type "t"
Sleep 4s
Type "r"
Sleep 4s
Type "m"
Sleep 4s
Type "p"
Sleep 4s

# back to the inbox and approve the rotation of the burnt-out worker
Type "i"
Sleep 2s
Type "w"
Sleep 3s
Type "t"
Sleep 35s

Escape
Sleep 1s
Type "/standup"
Enter
Sleep 16s
