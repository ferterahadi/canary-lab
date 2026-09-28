This is a runtime preflight, not a repair task. Use Bash once to execute exactly:

    /bin/bash ./runtime-preflight.sh

The script starts three local services with the documented runbook commands, runs Playwright, checks isolation, and stops its own services. Allow up to 120 seconds for the command. Expected failing tests are part of the preflight. Do not edit files, diagnose or repair the app, delegate, or run other commands. After the tool returns, report its exit status and whether its output contains NATIVE_RUNTIME_OK.
