"""Parse source only. Resolve simple names, URL expressions and direct helper calls.

No inspected code is imported or executed. Unsupported URL flows remain unknown.
"""
import ast
import itertools
import json
import os
import posixpath as path
import sys
import sysconfig

UNKNOWN = "<dynamic>"
NETWORK = "urllib.request."
SINKS = {NETWORK + "urlopen", NETWORK + "urlretrieve"}
REQUEST = NETWORK + "Request"
STDLIB = getattr(sys, "stdlib_module_names", None) or set(sys.builtin_module_names) | {
    name.removesuffix(".py") for name in os.listdir(sysconfig.get_path("stdlib"))
    if name.removesuffix(".py").isidentifier()
}
files = json.load(sys.stdin)
scopes, functions, calls, imports, urls, errors, all_scopes = {}, {}, [], [], [], [], []


def report(file, node, message):
    errors.append({"file": file, "line": getattr(node, "lineno", 1), "message": message})


def own(file, name, level=0):
    suffix = name.replace(".", "/")
    if level:
        base = path.dirname(file)
        for _ in range(level - 1):
            base = path.dirname(base)
        bases = [path.join(base, suffix)]
    else:
        bases = [path.join(prefix, suffix) for prefix in ("", "src", "packages", "containers", path.dirname(file))]
    matches = {path.normpath(candidate) for base in bases for candidate in (base + ".py", path.join(base, "__init__.py")) if path.normpath(candidate) in files}
    if len(matches) > 1:
        raise ValueError("Ambiguous own Python import: " + name)
    return next(iter(matches), None)


class Scope:
    def __init__(self, file, parent=None, key=""):
        self.file, self.parent, self.key = file, parent, key
        self.bindings, self.nodes = {}, []
        all_scopes.append(self)

    def bind(self, name, value):
        self.bindings.setdefault(name, []).append(value)

    def lookup(self, name):
        if name in self.bindings:
            return self.bindings[name]
        return self.parent.lookup(name) if self.parent else []


def collect(node, scope, parent=None):
    scope.nodes.append((node, parent))
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        key = scope.key + node.name
        scope.bind(node.name, key)
        child = Scope(scope.file, scope, key + ".")
        if not isinstance(node, ast.ClassDef):
            functions[key] = (node, child)
            for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                child.bindings[arg.arg] = []
        for header in ast.iter_child_nodes(node):
            if header not in node.body:
                collect(header, scope, node)
        for statement in node.body:
            collect(statement, child, node)
        return
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        for alias in node.names:
            name = alias.name if isinstance(node, ast.Import) else node.module or ""
            level = getattr(node, "level", 0)
            target = own(scope.file, name, level)
            member = own(scope.file, ".".join(filter(None, [name, alias.name])), level) if isinstance(node, ast.ImportFrom) else None
            imported = member or target
            imported_name = ".".join(filter(None, [name, alias.name])) if isinstance(node, ast.ImportFrom) else name
            imports.append({"file": scope.file, "name": imported_name, "line": node.lineno, "level": level, "target": imported, "stdlib": name.split(".")[0] in STDLIB})
            if alias.name == "*":
                report(scope.file, node, "Unsupported Python wildcard import")
            binding = alias.asname or (alias.name.split(".")[0] if isinstance(node, ast.Import) else alias.name)
            if imported:
                symbol = imported + "::" + ("" if member or isinstance(node, ast.Import) else alias.name)
                if isinstance(node, ast.Import) and "." in alias.name and not alias.asname:
                    report(scope.file, node, "Own dotted Python imports require an alias")
            else:
                symbol = alias.name if isinstance(node, ast.Import) and alias.asname else binding
                if isinstance(node, ast.ImportFrom):
                    symbol = ".".join(filter(None, [name, alias.name]))
            scope.bind(binding, symbol)
    if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if isinstance(target, ast.Name):
                scope.bind(target.id, (node.value, scope) if not isinstance(node, ast.AugAssign) else (None, scope))
    if isinstance(node, ast.Call):
        calls.append((node, scope))
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and not isinstance(parent, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
        scope.bind(node.id, (None, scope))
    if isinstance(node, ast.Lambda):
        child = Scope(scope.file, scope)
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            child.bindings[arg.arg] = []
        collect(node.body, child, node)
        return
    for child in ast.iter_child_nodes(node):
        collect(child, scope, node)


def symbol(node, scope, seen=frozenset()):
    if isinstance(node, ast.Attribute):
        base = symbol(node.value, scope, seen)
        return base + ("" if base.endswith("::") else ".") + node.attr if base else None
    if not isinstance(node, ast.Name) or (id(scope), node.id) in seen:
        return None
    seen = seen | {(id(scope), node.id)}
    values = {entry if isinstance(entry, str) else symbol(entry[0], entry[1], seen) for entry in scope.lookup(node.id)}
    if not values and node.id in {"getattr", "setattr", "delattr", "eval", "exec", "compile", "__import__"}:
        return "builtins." + node.id
    if len(values) > 1 and any(value and (value.startswith("urllib") or "::" in value) for value in values):
        return "<ambiguous>"
    return next(iter(values)) if len(values) == 1 else None


def combine(parts):
    if any(len(part) > 32 for part in parts):
        return {UNKNOWN}
    result = {""}
    for part in parts:
        result = {a + b for a, b in itertools.product(result, part)}
        if len(result) > 32:
            return {UNKNOWN}
    return result


def values(node, scope, seen=frozenset()):
    if node is None or (id(node), id(scope)) in seen:
        return {UNKNOWN}
    seen = seen | {(id(node), id(scope))}
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float)):
        return {str(node.value)}
    if isinstance(node, ast.Name):
        entries = scope.lookup(node.id)
        result = set()
        for entry in entries:
            if isinstance(entry, str):
                if "::" in entry:
                    file, name = entry.split("::", 1)
                    result.update(values(ast.Name(id=name), scopes[file], seen))
                else:
                    result.add(UNKNOWN)
            else:
                result.update(values(entry[0], entry[1], seen))
        return result or {UNKNOWN}
    if isinstance(node, ast.JoinedStr):
        return combine([values(part.value if isinstance(part, ast.FormattedValue) else part, scope, seen) for part in node.values])
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return combine([values(node.left, scope, seen), values(node.right, scope, seen)])
    if isinstance(node, ast.IfExp):
        return values(node.body, scope, seen) | values(node.orelse, scope, seen)
    if isinstance(node, ast.Call) and symbol(node.func, scope) == REQUEST:
        return values(argument(node, "url"), scope, seen)
    return {UNKNOWN}


def argument(node, name):
    return node.args[0] if node.args else next((kw.value for kw in node.keywords if kw.arg == name), None)


for file, text in files.items():
    try:
        scopes[file] = Scope(file, key=file + "::")
        collect(ast.parse(text, filename=file), scopes[file])
    except (SyntaxError, ValueError, RecursionError) as error:
        errors.append({"file": file, "line": getattr(error, "lineno", 1), "message": str(error)})

# Bind every direct callsite, including imports of own helpers. No helper name or
# parameter spelling grants a network exemption.
for node, scope in calls:
    function = functions.get(symbol(node.func, scope))
    if function:
        definition, target = function
        positional = definition.args.posonlyargs + definition.args.args
        defaults = dict(zip([arg.arg for arg in positional[-len(definition.args.defaults):]], definition.args.defaults))
        defaults.update({arg.arg: value for arg, value in zip(definition.args.kwonlyargs, definition.args.kw_defaults)})
        supplied = {arg.arg: value for arg, value in zip(positional, node.args)}
        supplied.update({kw.arg: kw.value for kw in node.keywords})
        spread = any(isinstance(arg, ast.Starred) for arg in node.args) or None in supplied
        for arg in positional + definition.args.kwonlyargs:
            value = None if spread else supplied.get(arg.arg, defaults.get(arg.arg))
            target.bind(arg.arg, (value, scope if arg.arg in supplied else target.parent))

for node, scope in calls:
    name = symbol(node.func, scope)
    if isinstance(node.func, ast.Attribute) and node.func.attr == "set_proxy":
        report(scope.file, node, "Unsupported Python request destination mutation")
    if name in SINKS or name == REQUEST:
        destination = argument(node, "fullurl" if name in SINKS else "url")
        # urlretrieve uses 'url', urlopen uses 'url' on supported Python releases.
        if destination is None:
            destination = argument(node, "url")
        for value in values(destination, scope):
            urls.append({"file": scope.file, "line": node.lineno, "value": value, "sink": True})
    elif name and name.startswith(NETWORK):
        report(scope.file, node, "Unsupported Python network call: " + name)
    elif name and name.startswith(("http.client.", "socket.", "urllib.robotparser.")):
        report(scope.file, node, "Unsupported Python network call: " + name)
    elif name and "<ambiguous>" in name:
        report(scope.file, node, "Unsupported ambiguous Python callable")
    elif name in {"builtins.getattr", "builtins.setattr", "builtins.delattr"} and node.args and (symbol(node.args[0], scope) or "").startswith("urllib"):
        report(scope.file, node, "Unsupported Python network attribute lookup or mutation")
    elif name in {"importlib.import_module", "builtins.__import__", "builtins.eval", "builtins.exec", "builtins.compile"} or isinstance(node.func, ast.Name) and node.func.id in {"__import__", "eval", "exec", "compile"}:
        report(scope.file, node, "Unsupported dynamic Python import or execution")

# All literals count, even in uncalled functions. Ignore f-string fragments;
# inspect the assembled expression so a constant host with a dynamic path works.
sensitive = {scope.key.removesuffix(".") for node, scope in calls if symbol(node.func, scope) in SINKS}
for _ in functions:
    sensitive.update(scope.key.removesuffix(".") for node, scope in calls if symbol(node.func, scope) in sensitive)

def literals(scope):
    for node, parent in scope.nodes:
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and not isinstance(parent, ast.JoinedStr):
            if node.value.startswith(("http://", "https://", "ws://", "wss://")):
                urls.append({"file": scope.file, "line": node.lineno, "value": node.value, "sink": False})
        if isinstance(node, ast.JoinedStr):
            for value in values(node, scope):
                if value.startswith(("http://", "https://", "ws://", "wss://")):
                    urls.append({"file": scope.file, "line": node.lineno, "value": value, "sink": False})
        name = symbol(node, scope)
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Store) and node.attr in {"full_url", "host", "selector"}:
            report(scope.file, node, "Unsupported Python request destination mutation")
        if name and name.startswith(NETWORK) and "__" in name:
            report(scope.file, node, "Unsupported Python network introspection")
        if name in SINKS | {REQUEST} | sensitive and not (isinstance(parent, ast.Attribute) or isinstance(parent, ast.Call) and parent.func is node or isinstance(parent, (ast.Assign, ast.AnnAssign)) and parent.value is node):
            report(scope.file, node, "Unsupported Python network callable escape: " + name)

for scope in all_scopes:
    literals(scope)
print(json.dumps({"imports": imports, "urls": urls, "errors": errors}))
