# Deploy

Clones a git branch and serves it as a site, with an optional sandboxed build.

## 0.0.1

The extension now ships from the extension repository rather than from the Aegis
tree. Its source, its tests and its release are all in one place, and the package a
store install downloads is built from that source by CI rather than zipped by hand
from the core repository.

What this changes for an install: the code arrives by installing Deploy from the
store, and the host opt-in is granted by that install rather than by anything the
Aegis installer does. A new Aegis starts with no extensions at all.

A site behind the directory now tells the application it serves who is reading
it. The proxy sets `X-Aegis-User`, `X-Aegis-Name` and `X-Aegis-Groups` from the
session the access guard already holds, and removes any header of those names
that came from the client, on every site. Until now a protected project was
guarded without ever learning the visitor's identity, so anything with roles of
its own had to ask for a second login in front of the first. Open sites receive
none of the three, and the values are percent-encoded so that a name the
directory spells with an accent cannot fail the request. `DEPLOY-CONTRACT.md`,
section `Who the request is from`, is where the names are fixed.

## 0.0.0

First store release. Until it, the extension reached a customer inside the Aegis
application copy, with no version of its own; publishing it here gives it an update
cadence separate from the dashboard's.
