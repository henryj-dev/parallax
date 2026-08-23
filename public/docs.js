/**
 * The API reference page.
 *
 * It renders whatever `/api/v1/openapi.json` currently says, so it describes the
 * process that answered rather than a build somebody generated once. Nothing
 * here is loaded from anywhere else: the content security policy this server
 * sends allows scripts and styles from this origin only, so a reference page
 * that pulled a renderer off a CDN would be a blank page with a console error.
 *
 * It does not offer to send the requests it documents. A "try it" button on a
 * page served by the control plane it edits is one mis-click away from applying
 * a zone somebody was reading about, and the example each operation carries is
 * a `curl` line that the caller runs deliberately, in a shell, where they can
 * see what it will do.
 *
 * It is also the one page here that is not translated, and deliberately. Almost
 * everything it draws comes out of the document -- every summary, every field
 * description, every error -- and that is written in English at its source, in
 * the command registry and in the schemas. Translating the six words of chrome
 * around it would advertise a Korean page and then serve an English one.
 */

const SPEC_URL = "/api/v1/openapi.json";
const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const $ = (selector) => document.querySelector(selector);

/** Everything rendered, so filtering does not have to re-read the document. */
let entries = [];

void start();

async function start() {
  let spec;
  try {
    spec = await load();
  } catch (error) {
    return fail(error);
  }
  $("#loading").hidden = true;
  renderOverview(spec);
  entries = flatten(spec);
  renderIndex(entries);
  renderOperations(spec, entries);
  $("#operation-count").textContent = String(entries.length);
  $("#operation-search").addEventListener("input", (event) => filter(event.target.value));
  document.addEventListener("click", onCopy);
}

async function load() {
  const response = await fetch(SPEC_URL, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(`the document could not be read (HTTP ${response.status})`);
  return response.json();
}

function fail(error) {
  $("#loading").hidden = true;
  const box = $("#failure");
  box.hidden = false;
  box.replaceChildren(...(String(error.message) === "unauthorized"
    ? [
      element("b", {}, "This control plane asks who you are."),
      element("p", {}, "The description is behind the same authentication as the rest of the API, because it describes this deployment."),
      element("p", {}, ["Sign in at the ", element("a", { href: "/" }, "portal"), " and come back, or read it with a token:"]),
      codeBlock(`curl -sH 'Authorization: Bearer $PARALLAX_TOKEN' ${origin()}${SPEC_URL}`),
    ]
    : [element("b", {}, "The OpenAPI document could not be loaded."), element("p", {}, String(error.message))]));
}

function renderOverview(spec) {
  const info = spec.info ?? {};
  const section = $("#overview");
  section.hidden = false;
  section.replaceChildren(
    element("h1", {}, `${info.title ?? "API"} ${info.version ?? ""}`.trim()),
    ...(info.summary ? [element("p", { class: "lede" }, info.summary)] : []),
    ...paragraphs(info.description),
    element("div", { class: "overview-meta" }, [
      element("span", {}, `OpenAPI ${spec.openapi}`),
      element("span", {}, `${countOperations(spec)} operations`),
      element("span", {}, `${Object.keys(spec.components?.schemas ?? {}).length} schemas`),
      ...(info.license?.name ? [element("span", {}, info.license.name)] : []),
    ]),
  );
}

function countOperations(spec) {
  return Object.values(spec.paths ?? {}).reduce((total, item) => total + Object.keys(item).length, 0);
}

/** One flat, ordered list of operations, grouped later by their tag. */
function flatten(spec) {
  const tagOrder = (spec.tags ?? []).map((tag) => tag.name);
  const list = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      const tag = (operation.tags ?? ["Other"])[0];
      list.push({
        id: operation.operationId ?? `${method}-${path}`,
        method: method.toUpperCase(),
        path,
        tag,
        operation,
        haystack: `${method} ${path} ${operation.summary ?? ""} ${operation["x-parallax-command"] ?? ""}`.toLowerCase(),
      });
    }
  }
  return list.sort((left, right) =>
    indexOrLast(tagOrder, left.tag) - indexOrLast(tagOrder, right.tag)
    || left.path.localeCompare(right.path)
    || indexOrLast(METHOD_ORDER, left.method) - indexOrLast(METHOD_ORDER, right.method));
}

function indexOrLast(order, value) {
  const at = order.indexOf(value);
  return at < 0 ? order.length : at;
}

function renderIndex(list) {
  const nav = $("#operation-index");
  const nodes = [];
  let tag = null;
  for (const entry of list) {
    if (entry.tag !== tag) {
      tag = entry.tag;
      nodes.push(element("span", { class: "eyebrow index-group" }, tag));
    }
    nodes.push(element("a", { class: "index-item", href: `#${entry.id}`, "data-id": entry.id }, [
      methodBadge(entry.method),
      element("code", {}, shortPath(entry.path)),
    ]));
  }
  nav.replaceChildren(...nodes);
}

/**
 * The index is narrow, and what has to survive being narrowed is the part that
 * differs between rows. Trimming the end does the opposite: five record routes
 * all begin `/zones/{zone}/views/{view}`, so cutting there leaves five rows
 * reading the same thing. The middle is what they share, so the middle goes.
 */
function shortPath(path) {
  const segments = path.replace(/^\/api\/v1/, "").split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  if (segments.length <= 3) return `/${segments.join("/")}`;
  return `/${segments[0]}/…/${segments.slice(-2).join("/")}`;
}

function renderOperations(spec, list) {
  const host = $("#operations");
  const nodes = [];
  let tag = null;
  for (const entry of list) {
    if (entry.tag !== tag) {
      tag = entry.tag;
      const described = (spec.tags ?? []).find((candidate) => candidate.name === tag);
      nodes.push(element("section", { class: "tag-heading" }, [
        element("h2", {}, tag),
        ...(described?.description ? [element("p", {}, described.description)] : []),
      ]));
    }
    nodes.push(renderOperation(spec, entry));
  }
  host.replaceChildren(...nodes);
}

function renderOperation(spec, entry) {
  const operation = entry.operation;
  const role = operation["x-parallax-role"];
  const command = operation["x-parallax-command"];
  const access = operation["x-parallax-access"];

  const body = [
    element("header", { class: "operation-title" }, [
      methodBadge(entry.method),
      element("code", { class: "operation-path" }, entry.path),
    ]),
    element("p", { class: "operation-summary" }, operation.summary ?? ""),
    ...paragraphs(operation.description),
    element("div", { class: "chips" }, [
      ...(role ? [chip(`role: ${role}`, `The least role that reaches this. Computed from the command's minimum and the security layer, not written down separately.`)] : []),
      ...(command ? [chip(`parallax ${command}`, "The command this route runs. The same one the command line takes.")] : []),
      ...(access ? [chip("answered before the dispatcher", access)] : []),
    ]),
  ];

  const parameters = operation.parameters ?? [];
  if (parameters.length > 0) body.push(renderParameters(parameters));
  if (operation.requestBody) body.push(renderRequestBody(spec, operation.requestBody));
  body.push(renderResponses(spec, operation.responses ?? {}));

  const sample = operation["x-parallax-sample"];
  if (sample) body.push(renderExample(entry.method, sample));

  return element("article", { class: "operation", id: entry.id, "data-id": entry.id }, body);
}

function renderParameters(parameters) {
  return element("div", { class: "block" }, [
    element("h3", {}, "Parameters"),
    table(["Name", "In", "Type", "Description"], parameters.map((parameter) => [
      element("code", {}, parameter.name + (parameter.required ? " *" : "")),
      parameter.in,
      element("code", { class: "type" }, typeName(parameter.schema)),
      markdownish(parameter.description ?? ""),
    ])),
  ]);
}

function renderRequestBody(spec, requestBody) {
  const schema = requestBody.content?.["application/json"]?.schema;
  return element("div", { class: "block" }, [
    element("h3", {}, `Request body${requestBody.required ? " (required)" : ""}`),
    ...(requestBody.description ? [element("p", {}, markdownish(requestBody.description))] : []),
    ...(schema ? [renderSchema(spec, schema)] : []),
  ]);
}

function renderResponses(spec, responses) {
  const rows = Object.entries(responses)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([status, response]) => [
      element("code", { class: statusClass(status) }, status),
      markdownish(response.description ?? ""),
      schemaLabel(response),
    ]);
  return element("div", { class: "block" }, [
    element("h3", {}, "Responses"),
    table(["Status", "Meaning", "Body"], rows),
  ]);
}

function schemaLabel(response) {
  const content = response.content ?? {};
  const type = Object.keys(content)[0];
  if (!type) return "";
  const schema = content[type]?.schema;
  if (!schema) return element("code", { class: "type" }, type);
  return element("code", { class: "type" }, typeName(schema));
}

function statusClass(status) {
  const code = Number(status);
  if (code < 300) return "status ok";
  if (code < 500) return "status warn";
  return "status bad";
}

function renderExample(method, sample) {
  const lines = [`curl -sS -X ${method} \\`];
  lines.push(`  -H 'Authorization: Bearer $PARALLAX_TOKEN' \\`);
  if (sample.body !== undefined) {
    lines.push(`  -H 'content-type: application/json' \\`);
    lines.push(`  -d '${JSON.stringify(sample.body)}' \\`);
  }
  lines.push(`  '${origin()}${sample.path}'`);
  return element("div", { class: "block" }, [
    element("h3", {}, "Example"),
    codeBlock(lines.join("\n")),
  ]);
}

function origin() {
  return window.location.origin;
}

// ---- schemas --------------------------------------------------------------

/** How deep a nested schema is drawn before it is left to the reader to follow. */
const MAX_DEPTH = 3;

function renderSchema(spec, schema, depth = 0) {
  const resolved = resolve(spec, schema);
  if (resolved.enum) {
    return element("div", { class: "schema" }, [
      element("code", { class: "type" }, typeName(schema)),
      element("p", { class: "enum" }, `one of: ${resolved.enum.join(", ")}`),
      ...(resolved.description ? [element("p", {}, markdownish(resolved.description))] : []),
    ]);
  }
  const merged = flattenAllOf(spec, resolved);
  const properties = merged.properties ?? {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    return element("div", { class: "schema" }, [
      element("code", { class: "type" }, typeName(schema)),
      ...(merged.description ? [element("p", {}, markdownish(merged.description))] : []),
    ]);
  }
  const required = new Set(merged.required ?? []);
  return element("div", { class: "schema" }, [
    ...(merged.description ? [element("p", {}, markdownish(merged.description))] : []),
    table(["Field", "Type", "Description"], names.map((name) => {
      const property = properties[name];
      const child = resolve(spec, property);
      const nested = depth < MAX_DEPTH && hasProperties(spec, child)
        ? renderSchema(spec, itemsOf(property) ?? property, depth + 1)
        : null;
      return [
        element("code", {}, name + (required.has(name) ? " *" : "")),
        element("code", { class: "type" }, typeName(property)),
        element("div", {}, [
          markdownish(child.description ?? ""),
          ...(child.enum ? [element("p", { class: "enum" }, `one of: ${child.enum.join(", ")}`)] : []),
          ...(nested ? [nested] : []),
        ]),
      ];
    })),
  ]);
}

function hasProperties(spec, schema) {
  const merged = flattenAllOf(spec, schema);
  if (Object.keys(merged.properties ?? {}).length > 0) return true;
  const items = merged.items ? resolve(spec, merged.items) : null;
  return Boolean(items && Object.keys(flattenAllOf(spec, items).properties ?? {}).length > 0);
}

function itemsOf(schema) {
  return schema?.items;
}

/** `allOf` is how this document says "that, plus these fields". */
function flattenAllOf(spec, schema) {
  if (!schema?.allOf) return schema ?? {};
  const merged = { properties: {}, required: [] };
  for (const part of schema.allOf) {
    const resolved = flattenAllOf(spec, resolve(spec, part));
    Object.assign(merged.properties, resolved.properties ?? {});
    merged.required.push(...(resolved.required ?? []));
    if (resolved.description && !merged.description) merged.description = resolved.description;
  }
  if (schema.description) merged.description = schema.description;
  return merged;
}

function resolve(spec, schema) {
  if (!schema) return {};
  if (!schema.$ref) return schema;
  const name = String(schema.$ref).replace("#/components/schemas/", "");
  return spec.components?.schemas?.[name] ?? {};
}

function typeName(schema) {
  if (!schema) return "any";
  if (schema.$ref) return String(schema.$ref).replace("#/components/schemas/", "");
  if (schema.allOf) return schema.allOf.map(typeName).join(" & ");
  if (schema.oneOf) return schema.oneOf.map(typeName).join(" | ");
  if (schema.type === "array") return `${typeName(schema.items)}[]`;
  if (schema.enum) return "enum";
  return schema.type ?? "any";
}

// ---- filtering ------------------------------------------------------------

function filter(term) {
  const needle = term.trim().toLowerCase();
  let shown = 0;
  for (const entry of entries) {
    const matches = needle === "" || entry.haystack.includes(needle);
    if (matches) shown += 1;
    for (const node of queryAll(`[data-id="${cssEscape(entry.id)}"]`)) node.hidden = !matches;
  }
  $("#operation-count").textContent = String(shown);
  // A group heading with nothing under it reads as an empty section rather than
  // as a section that was filtered out. Both columns group, so both are swept.
  for (const heading of queryAll(".tag-heading")) {
    heading.hidden = !hasVisibleAfter(heading, "tag-heading", "operation");
  }
  for (const heading of queryAll(".index-group")) {
    heading.hidden = !hasVisibleAfter(heading, "index-group", "index-item");
  }
}

/**
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
function queryAll(selector) {
  return /** @type {HTMLElement[]} */ ([...document.querySelectorAll(selector)]);
}

/**
 * Whether anything is still showing under a heading, where "under" runs to the
 * next heading of the same kind.
 *
 * @param {HTMLElement} heading
 * @param {string} stopClass the class that begins the next group
 * @param {string} itemClass what counts as something to show
 */
function hasVisibleAfter(heading, stopClass, itemClass) {
  let node = /** @type {HTMLElement} */ (heading.nextElementSibling);
  while (node && !node.classList.contains(stopClass)) {
    if (node.classList.contains(itemClass) && !node.hidden) return true;
    node = /** @type {HTMLElement} */ (node.nextElementSibling);
  }
  return false;
}

function cssEscape(value) {
  // The fallback escaped the quote and not the backslash, which is the one
  // ordering that does not work: a value ending in `\` turned into `[data-id="a\"]`,
  // where the backslash escapes the closing quote instead of being one, and the
  // selector runs on past it. Backslash first, then quote -- the other order
  // re-escapes the backslashes this line just added.
  //
  // Nothing reaches this today: `entry.id` comes from the server's own OpenAPI
  // document, and every browser that runs the portal has `CSS.escape`. It is
  // fixed because a fallback is exactly the code that gets read as safe and is
  // never exercised until the day it is.
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

// ---- copying --------------------------------------------------------------

async function onCopy(event) {
  const button = event.target.closest?.("[data-copy]");
  if (!button) return;
  const source = button.previousElementSibling?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(source);
    button.textContent = "Copied";
  } catch {
    // A browser that refuses the clipboard leaves the text selectable, which is
    // the fallback anyway. Saying "copied" when nothing was would be worse.
    button.textContent = "Select and copy";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 1600);
}

// ---- small DOM helpers ----------------------------------------------------

function element(tag, attributes, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) node.setAttribute(name, value);
  append(node, children);
  return node;
}

function append(node, children) {
  if (children === undefined || children === null) return;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

function table(headers, rows) {
  const head = element("tr", {}, headers.map((header) => element("th", {}, header)));
  const body = rows.map((cells) => element("tr", {}, cells.map((cell) => element("td", {}, cell))));
  return element("div", { class: "table-scroll" }, element("table", {}, [
    element("thead", {}, head),
    element("tbody", {}, body),
  ]));
}

function codeBlock(text) {
  return element("div", { class: "code" }, [
    element("pre", {}, element("code", {}, text)),
    element("button", { type: "button", class: "button compact quiet", "data-copy": "true" }, "Copy"),
  ]);
}

function chip(text, title) {
  return element("span", { class: "chip", title }, text);
}

function methodBadge(method) {
  return element("span", { class: `method ${method.toLowerCase()}` }, method);
}

function paragraphs(text) {
  if (!text) return [];
  return String(text).split(/\n\s*\n/).map((block) => element("p", {}, markdownish(block.replace(/\n/g, " "))));
}

/**
 * Only backticks, and only because every summary in this document is written by
 * hand with them. Rendering arbitrary markdown would mean building HTML from a
 * string, which is the one thing this page must not do.
 */
function markdownish(text) {
  const span = document.createElement("span");
  const parts = String(text).split(/`([^`]+)`/g);
  parts.forEach((part, index) => {
    if (part === "") return;
    span.append(index % 2 === 1 ? element("code", {}, part) : document.createTextNode(part));
  });
  return span;
}
