// Synthetic analytical fixture shared by single-turn and conversation evaluations.
export const SYNTHETIC_SQL = `CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,country TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),amount REAL,refund REAL,status TEXT,ordered_at TEXT);
CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),quantity INTEGER);
CREATE TABLE empty_events(id INTEGER,value REAL); CREATE TABLE legacy_orders(id INTEGER,amount REAL);
INSERT INTO customers VALUES(1,'Ada','Ghana'),(2,'Ben','Germany'),(3,'Cara','Ghana'),(4,'Dana',NULL);
INSERT INTO orders VALUES(1,1,120,20,'completed','2026-08-01'),(2,1,180,0,'completed','2026-08-16'),(3,2,75,0,'canceled','2026-08-10'),(4,2,95,5,'completed','2026-09-01'),(5,3,240,0,'completed','2026-08-22');
INSERT INTO order_items VALUES(1,1,1),(2,1,2),(3,2,3); INSERT INTO legacy_orders VALUES(1,100);`;
