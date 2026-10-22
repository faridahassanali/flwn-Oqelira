# foundry-provider spike

Goal: find out which Foundry route and which models work for the Oqelira agent loop.

Setup (works on Windows PowerShell, macOS, Linux; Node >= 20.6):

    copy .env.example .env     # (macOS/Linux: cp .env.example .env) then fill it in
    npm install

Run, in this order:

1. `npm run smoke` - which model answers on which route (HTTP status only)
2. `npm run spike` - streaming, tool call, 4-step tool loop, heavy-reasoning reply
