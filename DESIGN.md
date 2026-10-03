# DB Chat Design

DB Chat is a hosted web product. Before changing any customer-facing interface,
read these documents in order:

1. [Product and architecture](docs/SDD-WEB-CHAT.md)
2. [Web screen design](docs/WEB-DESIGN.md)
3. [Web style guide](docs/WEB-STYLE-GUIDE.md)

The web application in `src/web` is the only product interface. Token values
live in `src/web/styles.css`. The optional Electron shell displays the hosted
interface with native window controls; it has no renderer, visual system,
settings, or query engine of its own.

These documents describe the product as built. When a change alters what they
describe, update them in the same pull request.
