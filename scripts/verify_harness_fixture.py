"""Independently exercise a small pure-Python fixture without any model runtime."""
import argparse
import ast
import json
from pathlib import Path
import sys


ALLOWED_NODES = (
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.If, ast.IfExp,
    ast.Compare, ast.Gt, ast.GtE, ast.Lt, ast.LtE, ast.Eq, ast.NotEq,
    ast.Return, ast.Raise, ast.Call, ast.Name, ast.Load, ast.Store,
    ast.Constant, ast.Assign, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp,
    ast.USub, ast.UAdd, ast.Not,
)


def exercise_code(code):
    tree = ast.parse(code)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ValueError("Expected one generated function, not a script.")
    function = tree.body[0]
    if (
        function.name != "clamp"
        or [arg.arg for arg in function.args.args] != ["value", "lower", "upper"]
        or function.decorator_list
        or function.args.defaults
        or function.args.posonlyargs
        or function.args.kwonlyargs
        or function.args.vararg
        or function.args.kwarg
        or function.returns is not None
        or any(arg.annotation is not None for arg in function.args.args)
    ):
        raise ValueError("Generated function does not have the requested plain clamp signature.")
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED_NODES):
            raise ValueError(f"Unexpected generated syntax: {type(node).__name__}")
        if isinstance(node, ast.Call) and (
            not isinstance(node.func, ast.Name)
            or node.func.id not in {"min", "max", "ValueError"}
        ):
            raise ValueError("Generated fixture may only call min, max and ValueError.")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError("Dunder access is not part of this fixture.")
    namespace = {"__builtins__": {"min": min, "max": max, "ValueError": ValueError}}
    exec(compile(tree, "<reviewed-harness-fixture>", "exec"), namespace)
    clamp = namespace["clamp"]
    cases = [
        ((-1, 0, 10), 0), ((0, 0, 10), 0), ((5, 0, 10), 5),
        ((10, 0, 10), 10), ((11, 0, 10), 10), ((-3, -5, -1), -3),
        ((7, 5, 5), 5), ((2.5, 1.25, 2.25), 2.25),
    ]
    for args, expected in cases:
        actual = clamp(*args)
        if actual != expected:
            raise ValueError(f"clamp{args}: expected {expected}, got {actual}")
    try:
        clamp(5, 10, 0)
    except ValueError:
        return len(cases) + 1
    raise ValueError("Reversed bounds must raise ValueError.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    try:
        if args.negative_control:
            exercise_code("def clamp(value, lower, upper):\n    return value\n")
            raise ValueError("The known-broken fixture was incorrectly accepted.")
        if args.source is None:
            raise ValueError("--source is required.")
        code = args.source.read_text(encoding="utf-8")
        if len(code.encode("utf-8")) > 16000:
            raise ValueError("Expected a small pure-Python fixture.")
        result = {"cases_passed": exercise_code(code), "source": str(args.source.resolve())}
        if args.output:
            args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, SyntaxError, KeyError, TypeError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
