"use strict"

const { getPropertyName } = require("eslint-utils")
const { optionalRequire } = require("./optional-require")

/** @type {import("typescript")} */
const ts = optionalRequire(require, "typescript")

/**
 * Define handlers to disallow prototype methods.
 * @param {RuleContext} context The rule context.
 * @param {Record<string, readonly string[]>} nameMap The method names to disallow. The key is class names and that value is method names.
 * @returns {Record<string, (node: ASTNode) => void>} The defined handlers.
 */
function definePrototypeMethodHandler(context, nameMap) {
    const aggressive = getAggressiveOption(context)

    /** @type {ReadonlyMap<any, import("typescript").Node>} */
    const tsNodeMap = context.parserServices.esTreeNodeToTSNodeMap
    /** @type {import("typescript").TypeChecker} */
    const checker =
        context.parserServices.program &&
        context.parserServices.program.getTypeChecker()

    const isTS = Boolean(ts && tsNodeMap && checker)
    const hasFullType =
        isTS && context.parserServices.hasFullTypeInformation !== false

    /**
     * Check if the type of the given node is one of given class or not.
     * @param {MemberExpression} memberAccessNode The MemberExpression node.
     * @param {string} className The class name to disallow.
     * @returns {boolean} `true` if should disallow it.
     */
    function checkObjectType(memberAccessNode, className) {
        // If it's obvious, shortcut.
        if (memberAccessNode.object.type === "ArrayExpression") {
            return className === "Array"
        }
        if (
            memberAccessNode.object.type === "Literal" &&
            memberAccessNode.object.regex
        ) {
            return className === "RegExp"
        }
        if (
            (memberAccessNode.object.type === "Literal" &&
                typeof memberAccessNode.object.value === "string") ||
            memberAccessNode.object.type === "TemplateLiteral"
        ) {
            return className === "String"
        }

        // Test object type.
        return isTS
            ? checkByPropertyDeclaration(memberAccessNode, className) ||
                  checkByObjectExpressionType(memberAccessNode, className)
            : aggressive
    }

    /**
     * Check if the type of the given node by the declaration of `node.property`.
     * @param {MemberExpression} memberAccessNode The MemberExpression node.
     * @param {string} className The class name to disallow.
     * @returns {boolean} `true` if should disallow it.
     */
    function checkByPropertyDeclaration(memberAccessNode, className) {
        const tsNode = tsNodeMap.get(memberAccessNode.property)
        const symbol = tsNode && checker.getSymbolAtLocation(tsNode)
        const declarations = symbol && symbol.declarations

        if (declarations) {
            for (const declaration of declarations) {
                const type = checker.getTypeAtLocation(declaration.parent)
                if (type && typeEquals(type, className)) {
                    return true
                }
            }
        }

        return false
    }

    /**
     * Check if the type of the given node by the type of `node.object`.
     * @param {MemberExpression} memberAccessNode The MemberExpression node.
     * @param {string} className The class name to disallow.
     * @returns {boolean} `true` if should disallow it.
     */
    function checkByObjectExpressionType(memberAccessNode, className) {
        const tsNode = tsNodeMap.get(memberAccessNode.object)
        const type = checker.getTypeAtLocation(tsNode)
        return typeEquals(type, className)
    }

    /**
     * Check if the name of the given type is expected or not.
     * @param {import("typescript").Type} type The type to check.
     * @param {string} className The expected type name.
     * @returns {boolean} `true` if should disallow it.
     */
    function typeEquals(type, className) {
        // console.log(
        //     "typeEquals(%o, %o)",
        //     {
        //         name: isClassOrInterface(type)
        //             ? type.symbol.escapedName
        //             : checker.typeToString(type),
        //         flags: Object.entries(ts.TypeFlags)
        //             .filter(
        //                 ([_id, flag]) =>
        //                     typeof flag === "number" &&
        //                     (type.flags & flag) === flag,
        //             )
        //             .map(([id]) => id)
        //             .join("|"),
        //         objectFlags:
        //             type.objectFlags == null
        //                 ? undefined
        //                 : Object.entries(ts.ObjectFlags)
        //                       .filter(
        //                           ([_id, flag]) =>
        //                               typeof flag === "number" &&
        //                               (type.objectFlags & flag) === flag,
        //                       )
        //                       .map(([id]) => id)
        //                       .join("|"),
        //     },
        //     className,
        // )

        if (isAny(type) || isUnknown(type)) {
            return aggressive
        }
        if (isAnonymousObject(type)) {
            // In non full-type mode, array types (e.g. `any[]`) become anonymous object type.
            return hasFullType ? false : aggressive
        }

        if (isStringLike(type)) {
            return className === "String"
        }
        if (isArrayLikeObject(type)) {
            return className === "Array"
        }

        if (isReferenceObject(type) && type.target !== type) {
            return typeEquals(type.target, className)
        }
        if (isTypeParameter(type)) {
            const constraintType = getConstraintType(type)
            if (constraintType) {
                return typeEquals(constraintType, className)
            }
            return hasFullType ? false : aggressive
        }
        if (isUnionOrIntersection(type)) {
            return type.types.some(t => typeEquals(t, className))
        }

        if (isClassOrInterface(type)) {
            const name = type.symbol.escapedName
            return name === className || name === `Readonly${className}`
        }
        return checker.typeToString(type) === className
    }

    /**
     * Get the constraint type of a given type parameter type if exists.
     *
     * `type.getConstraint()` method doesn't return the constraint type of the
     * type parameter for some reason. So this gets the constraint type via AST.
     *
     * @param {import("typescript").TypeParameter} type The type parameter type to get.
     * @returns {import("typescript").Type | undefined} The constraint type.
     */
    function getConstraintType(type) {
        const symbol = type.symbol
        const declarations = symbol && symbol.declarations
        const declaration = declarations && declarations[0]
        if (
            ts.isTypeParameterDeclaration(declaration) &&
            declaration.constraint != null
        ) {
            return checker.getTypeFromTypeNode(declaration.constraint)
        }
        return undefined
    }

    // For performance
    const nameMapEntries = Object.entries(nameMap)
    if (nameMapEntries.length === 1) {
        const [[className, methodNames]] = nameMapEntries
        return {
            MemberExpression(node) {
                const propertyName = getPropertyName(node, context.getScope())
                if (
                    methodNames.includes(propertyName) &&
                    checkObjectType(node, className)
                ) {
                    context.report({
                        node,
                        messageId: "forbidden",
                        data: {
                            name: `${className}.prototype.${propertyName}`,
                        },
                    })
                }
            },
        }
    }

    return {
        MemberExpression(node) {
            const propertyName = getPropertyName(node, context.getScope())
            for (const [className, methodNames] of nameMapEntries) {
                if (
                    methodNames.includes(propertyName) &&
                    checkObjectType(node, className)
                ) {
                    context.report({
                        node,
                        messageId: "forbidden",
                        data: {
                            name: `${className}.prototype.${propertyName}`,
                        },
                    })
                    return
                }
            }
        },
    }
}

/**
 * Get `aggressive` option value.
 * @param {RuleContext} context The rule context.
 * @returns {boolean} The gotten `aggressive` option value.
 */
function getAggressiveOption(context) {
    const options = context.options[0]
    const globalOptions = context.settings.es

    if (options && typeof options.aggressive === "boolean") {
        return options.aggressive
    }
    if (globalOptions && typeof globalOptions.aggressive === "boolean") {
        return globalOptions.aggressive
    }

    return false
}

/**
 * Check if a given type is an anonymous object type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").ObjectType} `true` if the type is an anonymous object type.
 */
function isAnonymousObject(type) {
    return isObject(type) && (type.objectFlags & ts.ObjectFlags.Anonymous) !== 0
}

/**
 * Check if a given type is `any` or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {boolean} `true` if the type is `any`.
 */
function isAny(type) {
    return (type.flags & ts.TypeFlags.Any) !== 0
}

/**
 * Check if a given type is an array-like type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").ObjectType} `true` if the type is an array-like type.
 */
function isArrayLikeObject(type) {
    return (
        isObject(type) &&
        (type.objectFlags &
            (ts.ObjectFlags.ArrayLiteral |
                ts.ObjectFlags.EvolvingArray |
                ts.ObjectFlags.Tuple)) !==
            0
    )
}

/**
 * Check if a given type is an interface type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").InterfaceType} `true` if the type is an interface type.
 */
function isClassOrInterface(type) {
    return (
        isObject(type) &&
        (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0
    )
}

/**
 * Check if a given type is an object type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").ObjectType} `true` if the type is an object type.
 */
function isObject(type) {
    return (type.flags & ts.TypeFlags.Object) !== 0
}

/**
 * Check if a given type is a reference type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").TypeReference} `true` if the type is a reference type.
 */
function isReferenceObject(type) {
    return isObject(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0
}

/**
 * Check if a given type is a string-like type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {boolean} `true` if the type is a string-like type.
 */
function isStringLike(type) {
    return (type.flags & ts.TypeFlags.StringLike) !== 0
}

/**
 * Check if a given type is a type parameter type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {boolean} `true` if the type is a type parameter type.
 */
function isTypeParameter(type) {
    return (type.flags & ts.TypeFlags.TypeParameter) !== 0
}

/**
 * Check if a given type is a union-or-intersection type or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {type is import("typescript").UnionOrIntersectionType} `true` if the type is a union-or-intersection type.
 */
function isUnionOrIntersection(type) {
    return (type.flags & ts.TypeFlags.UnionOrIntersection) !== 0
}

/**
 * Check if a given type is `unknown` or not.
 * @param {import("typescript").Type} type The type to check.
 * @returns {boolean} `true` if the type is `unknown`.
 */
function isUnknown(type) {
    return (type.flags & ts.TypeFlags.Unknown) !== 0
}

module.exports = { definePrototypeMethodHandler }