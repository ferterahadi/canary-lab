This is a permission preflight, not a repair task. Use Bash once to execute exactly this command from the nested run directory:

```sh
{{command}}
```

The command reads an application helper and a local JSON summary through Python, then checks that private experiment files cannot be read and the permission configuration cannot be written. Those denials are expected. Do not change the command, edit files, diagnose the application, delegate, or request broader permissions. After the tool returns, report its exit status.
