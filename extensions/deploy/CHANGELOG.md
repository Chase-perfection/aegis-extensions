# Deploy

Clones a git branch and serves it as a site, with an optional sandboxed build.

## Unreleased

The extension now ships from the extension repository rather than from the Aegis
tree. Its source, its tests and its release are all in one place, and the package a
store install downloads is built from that source by CI rather than zipped by hand
from the core repository.

What this changes for an install: the code arrives by installing Deploy from the
store, and the host opt-in is granted by that install rather than by anything the
Aegis installer does. A new Aegis starts with no extensions at all.

## 0.0.0

First store release. Until it, the extension reached a customer inside the Aegis
application copy, with no version of its own; publishing it here gives it an update
cadence separate from the dashboard's.
