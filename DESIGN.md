# DB Chat Design

DB Chat is a hosted web product. Before changing any customer-facing interface,
read these canonical documents in order:

1. [Web product specification](docs/SDD-WEB-CHAT.md)
2. [Web screen design](docs/WEB-DESIGN.md)
3. [Web style guide](docs/WEB-STYLE-GUIDE.md)

The web application in `src/web` is the only product interface. The optional
Electron shell displays that hosted interface and uses native window controls;
it does not maintain its own renderer, visual system, settings or query engine.

Customers create accounts and add their own database connections. Supabase stores
DB Chat account and application records, not a catalog of customer-accessible
databases. Email/password authentication is the initial scope; OAuth is deferred.
There is no invitation-only or bounded-beta requirement. Validate each supported
engine and extend the engine list as the product develops.

The Scape/macOS pack in `docs/scape-redesign/` and the older Codex style guide
are historical documentation for the retired desktop renderer. They are not
implementation sources for the hosted product or its thin desktop wrapper.
