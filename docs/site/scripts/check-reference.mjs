import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(site, "../..");
const content = resolve(site, "src/content/docs");
const catalog = JSON.parse(readFileSync(resolve(site, "src/reference-map.json"), "utf8"));
const failures = [];
let count = 0;

function source(path) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

// Follow relative re-exports, while excluding declarations that only exist as types.
function runtimeExports(path, visited = new Set()) {
  if (visited.has(path)) return new Set();
  visited.add(path);
  const names = new Set();
  for (const node of source(path).statements) {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly) names.add(element.name.text);
        }
      } else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        if (module.startsWith(".")) {
          for (const name of runtimeExports(resolve(dirname(path), module), visited))
            names.add(name);
        } else failures.push(`Unsupported star export: ${path} -> ${module}`);
      }
    } else if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        names.add(node.name.text);
      }
    }
  }
  return names;
}

function pageText(slug) {
  try {
    return readFileSync(resolve(content, `${slug}.mdx`), "utf8");
  } catch {
    failures.push(`Missing documentation page: ${slug}`);
    return "";
  }
}

function checkNames(actual, pages, label) {
  const documented = new Set();
  for (const [slug, names] of Object.entries(pages)) {
    const text = pageText(slug);
    for (const name of names) {
      if (documented.has(name)) failures.push(`${label}: duplicate mapping for ${name}`);
      documented.add(name);
      if (!actual.has(name)) failures.push(`${label}: stale mapping for ${name}`);
      if (!text.includes(name)) failures.push(`${slug}: mapped ${name} is absent from the page`);
    }
  }
  for (const name of actual) {
    if (!documented.has(name)) failures.push(`${label}: undocumented ${name}`);
  }
  count += actual.size;
}

for (const entry of catalog.packages) {
  checkNames(runtimeExports(resolve(root, entry.source)), entry.pages, entry.name);
}

function members(path, typeName) {
  const declaration = source(resolve(root, path)).statements.find(
    (node) =>
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === typeName,
  );
  const body = ts.isTypeAliasDeclaration(declaration) ? declaration.type : declaration;
  if (!body?.members) throw new Error(`Cannot inspect ${path}: ${typeName}`);
  return new Set(body.members.map((member) => member.name?.getText()).filter(Boolean));
}

for (const entry of catalog.members) {
  checkNames(members(entry.source, entry.type), entry.pages, entry.type);
}

// CLI syntax, operation names and accepted configuration keywords also need a reference.
const commands = new Set();
function visitCommands(node) {
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression))
    commands.add(node.expression.text);
  if (
    ts.isBinaryExpression(node) &&
    node.left.getText() === "command" &&
    ts.isStringLiteral(node.right)
  ) {
    if (!node.right.text.startsWith("--")) commands.add(node.right.text);
  }
  ts.forEachChild(node, visitCommands);
}
visitCommands(source(resolve(root, "packages/cli/src/main.ts")));
checkNames(commands, catalog.commands, "CLI commands");

function operationNames(path) {
  const names = new Set();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineNativePlugin" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const fields = new Map(
        node.arguments[0].properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [property.name.getText(), property.initializer]),
      );
      const name = fields.get("name");
      const operations = fields.get("operations");
      if (
        name &&
        ts.isStringLiteral(name) &&
        operations &&
        ts.isObjectLiteralExpression(operations)
      )
        for (const operation of operations.properties)
          if (
            ts.isPropertyAssignment(operation) &&
            (ts.isIdentifier(operation.name) || ts.isStringLiteral(operation.name))
          )
            names.add(`${name.text}.${operation.name.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source(resolve(root, path)));
  return names;
}
checkNames(
  new Set(
    ["storage", "log", "capabilities"].flatMap((name) => [
      ...operationNames(`plugins/${name}/src/index.ts`),
    ]),
  ),
  catalog.operations,
  "Host operations",
);

function checkFields(fields, slugs, label) {
  const text = slugs.map(pageText).join("\n");
  for (const field of fields) {
    if (!text.includes(field))
      failures.push(`${label}: field ${field} is absent from ${slugs.join(", ")}`);
  }
  count += fields.size;
}
checkFields(
  members("packages/protocol/src/validation.ts", "Schema"),
  ["reference/schema"],
  "Schema keywords",
);

const policyFields = new Set();
for (const node of source(resolve(root, "packages/protocol/src/schema.ts")).statements) {
  if (!ts.isVariableStatement(node)) continue;
  for (const declaration of node.declarationList.declarations) {
    if (!["policySchema", "hostPermissions"].includes(declaration.name.getText())) continue;
    function visit(node) {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "properties" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const field of node.initializer.properties)
          if (field.name) policyFields.add(field.name.getText());
      }
      ts.forEachChild(node, visit);
    }
    if (declaration.initializer) visit(declaration.initializer);
  }
}
checkFields(policyFields, ["reference/policy"], "Policy fields");

for (const [path, slugs] of Object.entries(catalog.configuration)) {
  const fields = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "keys") {
      const allowed = node.arguments[1];
      if (allowed && ts.isArrayLiteralExpression(allowed)) {
        for (const item of allowed.elements) if (ts.isStringLiteral(item)) fields.add(item.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ["TOP_LEVEL", "CHANNEL_KEYS", "WINDOWS_ICONS", "MACOS_ICONS", "SIGNING_KEYS"].includes(
        node.name.getText(),
      )
    ) {
      function strings(child) {
        if (ts.isStringLiteral(child)) fields.add(child.text);
        ts.forEachChild(child, strings);
      }
      if (node.initializer) strings(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source(resolve(root, path)));
  checkFields(fields, slugs, path);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation coverage: ${count} public exports, members, commands, operations and configuration keywords checked.`,
  );
}
