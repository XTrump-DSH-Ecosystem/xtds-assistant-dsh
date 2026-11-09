import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

test("client bundle loads through __ModuleLoader__ and registers the sidebar footer", () => {
  const source = readFileSync(join(import.meta.dirname, "../lib/client.js"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
  let loaded = null;
  let registration = null;
  const reactStub = {
    createElement: () => ({}),
    Fragment: {},
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn
  };
  const reactDomStub = {
    createPortal: (node, target) => ({ node, target })
  };
  const style = { dataset: {}, textContent: "" };
  const documentStub = {
    querySelector: () => null,
    createElement: () => style,
    head: { append: () => {} }
  };
  const context = {
    window: {
      __ModuleLoader__: {
        load(record) {
          loaded = record;
          const exported = record.factory((id) => {
            assert.ok(id === "react" || id === "react-dom");
            return id === "react" ? reactStub : reactDomStub;
          });
          const ctx = {
            slots: {
              inject(slotName, callback) {
                assert.equal(slotName, "sidebar.footer.action");
                callback();
              },
              register(options, component) {
                registration = { options, component };
                return () => {};
              }
            }
          };
          exported.apply(ctx);
        }
      },
      fetch: () => Promise.reject(new Error("not used")),
      setInterval: () => 1,
      clearInterval: () => {}
    },
    document: documentStub,
    console
  };
  vm.runInNewContext(source, context, { filename: "client.js" });
  assert.equal(loaded.id, "xtds-assistant-dsh");
  assert.equal(registration.options.name, "sidebar.footer.action");
  assert.equal(registration.options.id, "xtds-assistant-dsh");
  assert.equal(typeof registration.component, "function");
  assert.equal(packageJson.dsh.client.platform, "web");
  assert.equal(packageJson.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(packageJson.exports["./client"], "./lib/client.js");
  assert.match(source, /reactDom\.createPortal\(panel, document\.body\)/);
  assert.match(source, /data-theme/);
  assert.match(source, /xtds-assistant-theme/);
  assert.match(source, /const snowlumaRow = snowlumaRowForProcess\(entry, snapshot && snapshot\.snowluma\)/);
  assert.match(source, /\n\s+snowlumaRow,/);
});
