import { existsSync, readFileSync } from "fs";
import type { SessionEntry } from "./session-manager.js";

/**
 * A node in the session tree, representing a single entry
 * with references to its children.
 */
export interface SessionNode {
	id: string;
	parentId: string | null;
	entry: SessionEntry;
	children: string[];
}

/**
 * In-memory graph representation of a session for navigation.
 *
 * Parses JSONL session files into a tree structure and provides
 * methods for traversing branches, finding paths, and accessing
 * nodes by ID.
 */
export class SessionGraph {
	/** All nodes indexed by entry ID */
	readonly nodes: Map<string, SessionNode> = new Map();

	/** ID of the root entry (first entry with parentId === null) */
	rootId: string | null = null;

	/** ID of the current leaf entry (last entry in the session) */
	leafId: string | null = null;

	private constructor() {}

	/**
	 * Load a session graph from a JSONL file.
	 * @param sessionPath Path to the .jsonl session file
	 * @returns SessionGraph instance
	 * @throws Error if the file doesn't exist or is invalid
	 */
	static fromSession(sessionPath: string): SessionGraph {
		if (!existsSync(sessionPath)) {
			throw new Error(`Session file not found: ${sessionPath}`);
		}

		const content = readFileSync(sessionPath, "utf8");
		const entries: SessionEntry[] = [];

		for (const line of content.trim().split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { type: string; id?: string; parentId?: string | null };
				// Skip session header (no id/parentId)
				if (entry.type === "session") continue;
				if (typeof entry.id !== "string") continue;
				entries.push(entry as SessionEntry);
			} catch {
				// Skip malformed lines
			}
		}

		return SessionGraph.fromEntries(entries);
	}

	/**
	 * Build a session graph from an array of session entries.
	 * @param entries Array of session entries with id/parentId
	 * @returns SessionGraph instance
	 */
	static fromEntries(entries: SessionEntry[]): SessionGraph {
		const graph = new SessionGraph();

		// Build node map and find root/leaf
		for (const entry of entries) {
			const node: SessionNode = {
				id: entry.id,
				parentId: entry.parentId,
				entry,
				children: [],
			};
			graph.nodes.set(entry.id, node);

			// Track root (parentId === null)
			if (entry.parentId === null) {
				graph.rootId = entry.id;
			}

			// Track leaf (always advances to last entry)
			graph.leafId = entry.id;
		}

		// Build children arrays
		for (const node of graph.nodes.values()) {
			if (node.parentId !== null) {
				const parent = graph.nodes.get(node.parentId);
				if (parent) {
					parent.children.push(node.id);
				}
			}
		}

		// Sort children by timestamp (oldest first)
		for (const node of graph.nodes.values()) {
			node.children.sort((a, b) => {
				const nodeA = graph.nodes.get(a);
				const nodeB = graph.nodes.get(b);
				if (!nodeA || !nodeB) return 0;
				return new Date(nodeA.entry.timestamp).getTime() - new Date(nodeB.entry.timestamp).getTime();
			});
		}

		return graph;
	}

	/**
	 * Get the root node of the session tree.
	 * @returns Root node or undefined if no root exists
	 */
	getRoot(): SessionNode | undefined {
		return this.rootId ? this.nodes.get(this.rootId) : undefined;
	}

	/**
	 * Get the current leaf node (last entry in the session).
	 * @returns Leaf node or undefined if session is empty
	 */
	getLeaf(): SessionNode | undefined {
		return this.leafId ? this.nodes.get(this.leafId) : undefined;
	}

	/**
	 * Get a node by its ID.
	 * @param id Entry ID
	 * @returns Node or undefined if not found
	 */
	getNode(id: string): SessionNode | undefined {
		return this.nodes.get(id);
	}

	/**
	 * Get all entries in a branch from root to the specified entry.
	 * If no fromId is provided, uses the current leaf.
	 * @param fromId Entry ID to walk from (defaults to leaf)
	 * @returns Array of entries from root to the entry (inclusive)
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const startId = fromId ?? this.leafId;
		if (!startId) return [];

		const path: SessionEntry[] = [];
		let current = this.nodes.get(startId);

		while (current) {
			path.unshift(current.entry);
			current = current.parentId ? this.nodes.get(current.parentId) : undefined;
		}

		return path;
	}

	/**
	 * Get all direct children of an entry.
	 * @param parentId Parent entry ID
	 * @returns Array of child entries, sorted by timestamp (oldest first)
	 */
	getChildren(parentId: string): SessionEntry[] {
		const parent = this.nodes.get(parentId);
		if (!parent) return [];

		return parent.children.map((id) => this.nodes.get(id)!).filter(Boolean).map((node) => node.entry);
	}

	/**
	 * Get the path between two nodes.
	 * @param fromId Starting entry ID
	 * @param toId Target entry ID
	 * @returns Array of entries from fromId to toId (inclusive), or empty array if no path exists
	 */
	getPath(fromId: string, toId: string): SessionEntry[] {
		const fromNode = this.nodes.get(fromId);
		const toNode = this.nodes.get(toId);

		if (!fromNode || !toNode) return [];

		// Build path from 'to' up to root
		const toPath: SessionEntry[] = [];
		let current = toNode;
		while (current) {
			toPath.unshift(current.entry);
			current = current.parentId ? this.nodes.get(current.parentId) : undefined;
		}

		// Build path from 'from' up to root
		const fromPath: SessionEntry[] = [];
		current = fromNode;
		while (current) {
			fromPath.unshift(current.entry);
			current = current.parentId ? this.nodes.get(current.parentId) : undefined;
		}

		// Find common ancestor
		let commonAncestorIdx = -1;
		for (let i = 0; i < Math.min(toPath.length, fromPath.length); i++) {
			if (toPath[i].id === fromPath[i].id) {
				commonAncestorIdx = i;
			} else {
				break;
			}
		}

		if (commonAncestorIdx === -1) return [];

		// Build path: fromId -> ... -> common ancestor -> ... -> toId
		// Walk up from fromId to common ancestor (excluding common ancestor)
		const result: SessionEntry[] = [];
		const fromToAncestor: SessionEntry[] = [];
		current = fromNode;
		while (current && current.id !== toPath[commonAncestorIdx].id) {
			fromToAncestor.unshift(current.entry);
			current = current.parentId ? this.nodes.get(current.parentId) : undefined;
		}

		// Walk down from common ancestor to toId
		const ancestorToTo: SessionEntry[] = [];
		current = toNode;
		while (current && current.id !== toPath[commonAncestorIdx].id) {
			ancestorToTo.push(current.entry);
			current = current.parentId ? this.nodes.get(current.parentId) : undefined;
		}
		ancestorToTo.reverse();

		// Combine: fromToAncestor (fromId -> common ancestor, excluding ancestor) + ancestorToTo (ancestor -> toId)
		result.push(...fromToAncestor);
		result.push(...ancestorToTo);

		return result;
	}
}
