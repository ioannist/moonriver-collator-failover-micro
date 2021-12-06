# moonriver-collator-failover-micro
Failover service for Moonriver Collators based on 1 microservice

Moonriver Failover - step by step
0. Create an AuthorMapping proxy account
1. Setup Private Telemetry server
2. Install NodeJS 14, and npm to your local machine
3. Clone github repo, edit code, and build
4. Create Lambda microservice in AWS

This is how it works in a nutshell
- Every X minutes, connect to private/public telemetry, check current block of our active server and backup server/s
- Compare with current chain block height
-If there is a block lag on the active machine, perform an AuthorMapping updateAssociation and switch to a healthy backup
