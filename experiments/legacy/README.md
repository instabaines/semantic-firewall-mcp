# v1.0 (original implementation)

`v1.0/` is the first implementation of the gateway, unchanged. It is kept only so
that the protocol-exploit experiment (E2) can attack it and show that each flaw
listed in `docs/SECURITY_FINDINGS.md` was real. **It is deliberately vulnerable;
do not deploy it.**

`reproduce.sh` links the repository's `node_modules` into `v1.0/` and starts its
components on separate ports; nothing needs to be done by hand.
