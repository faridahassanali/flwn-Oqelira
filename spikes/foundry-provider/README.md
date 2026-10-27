# foundry-provider spike

Goal: find out which Foundry route and which models work for the Oqelira agent loop.

Setup (works on Windows PowerShell, macOS, Linux; Node >= 20.6):

    # uses the .env at the repo root (two levels up); see the root .env.example
    npm install

Run, in this order:

1. `npm run smoke` - which model answers on which route (HTTP status only)
2. `npm run spike` - streaming, tool call, 4-step tool loop, heavy-reasoning reply

Send both outputs back (never the key) and we decide the provider layer from them.
`smoke.sh` is the same smoke test for bash users.
