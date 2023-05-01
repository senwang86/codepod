/**
 * See this PR for how the Canvas data is maintained:
 * https://github.com/codepod-io/codepod/pull/205
 */

import { createStore, StateCreator, StoreApi } from "zustand";
import { MyState, Pod } from ".";

import { produce } from "immer";

import { useCallback, useEffect, useState, useContext } from "react";
import { useStore } from "zustand";
import { ApolloClient, useApolloClient, gql } from "@apollo/client";
import { Transaction, YEvent } from "yjs";

import { match, P } from "ts-pattern";

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  forceX,
  forceY,
  SimulationNodeDatum,
  SimulationLinkDatum,
} from "d3-force";

import { myNanoId } from "../utils";

import {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  addEdge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  XYPosition,
  MarkerType,
  NodeDragHandler,
  ReactFlowInstance,
} from "reactflow";
import { node } from "prop-types";
import { fixTables } from "@remirror/pm/dist-types/tables";

// TODO add node's data typing.
type NodeData = {
  level?: number;
};

// FIXME put this into utils
const level2color = {
  0: "rgba(187, 222, 251, 0.5)",
  1: "rgba(144, 202, 249, 0.5)",
  2: "rgba(100, 181, 246, 0.5)",
  3: "rgba(66, 165, 245, 0.5)",
  4: "rgba(33, 150, 243, 0.5)",
  // default: "rgba(255, 255, 255, 0.2)",
  default: "rgba(240,240,240,0.25)",
};

/**
 * Creare the temporary nodes as well as the temporary pods based on the given pod.
 * @param pod
 * @param position
 * @param parent
 * @param level
 * @returns
 */
function createTemporaryNode(pod, position, parent = "ROOT", level = 0): any {
  const id = myNanoId();
  let style = {
    // create a temporary half-transparent pod
    opacity: 0.5,
    width: pod.width,
  };

  if (pod.type === "SCOPE") {
    style["height"] = pod.height!;
    style["backgroundColor"] = level2color[level] || level2color["default"];
  }

  const newNode = {
    id,
    type: pod.type,
    position,
    data: {
      label: id,
      parent,
      level,
    },
    dragHandle: ".custom-drag-handle",
    width: pod.width,
    height: pod.height!,
    // Note: when the temporary node is finally sticked to the canvas, the click event will trigger drag event/position change of this node once and cause a bug because the node is not ready in the store and DB. just make it undraggable during moving to avoid this bug.
    draggable: false,
    style,
  };

  if (parent !== "ROOT") {
    newNode["parentNode"] = parent;
  }

  const newPod = { ...pod, parent, id, position, children: [] };
  const nodes = [[newNode, newPod]];
  pod.children.forEach((child) => {
    nodes.push(
      ...createTemporaryNode(child, { x: child.x, y: child.y }, id, level + 1)
    );
  });
  return nodes;
}

/**
 * The new reactflow nodes for context-menu's addXXX items.
 */
function createNewNode(type: "SCOPE" | "CODE" | "RICH", position): Node {
  let id = myNanoId();
  const newNode = {
    id,
    type,
    position,
    ...(type === "SCOPE"
      ? {
          width: 600,
          height: 600,
          style: { backgroundColor: level2color[0], width: 600, height: 600 },
        }
      : {
          width: 300,
          // Previously, we should not specify height, so that the pod can grow
          // when content changes. But when we add auto-layout on adding a new
          // node, unspecified height will cause  the node to be added always at
          // the top-left corner (the reason is unknown). Thus, we have to
          // specify the height here. Note that this height is a dummy value;
          // the content height will still be adjusted based on content height.
          height: 200,
          style: {
            width: 300,
            // It turns out that this height should not be specified to let the
            // height change automatically.
            //
            // height: 200
          },
        }),
    data: {
      label: id,
      name: "",
      parent: "ROOT",
      level: 0,
    },
    dragHandle: ".custom-drag-handle",
  };
  return newNode;
}

function getAbsPos(node: Node, nodesMap) {
  let x = node.position.x;
  let y = node.position.y;
  if (node.parentNode) {
    // FIXME performance.
    let [dx, dy] = getAbsPos(nodesMap.get(node.parentNode), nodesMap);
    return [x + dx, y + dy];
  } else {
    return [x, y];
  }
}

function getScopeAt(
  x: number,
  y: number,
  excludes: string[],
  nodes,
  nodesMap
): Node {
  const scope = nodes.findLast((node) => {
    let [x1, y1] = getAbsPos(node, nodesMap);
    return (
      node.type === "SCOPE" &&
      x >= x1 &&
      !excludes.includes(node.id) &&
      x <= x1 + node.width &&
      y >= y1 &&
      y <= y1 + node.height
    );
  });
  return scope;
}

function getNodePositionInsideScope(
  node: Node,
  scope: Node,
  nodesMap,
  nodeHeight: number = 0
): XYPosition {
  // compute the actual position
  let [x, y] = getAbsPos(node, nodesMap);
  let [dx, dy] = getAbsPos(scope, nodesMap);
  x -= dx;
  y -= dy;
  return { x, y };
}

/**
 * Sort the nodes. The parent nodes will appear before the child nodes. This
 * function is used to adjust node levels (adjustLevel).
 * @param nodes
 * @param nodesMap
 * @returns
 */
function topologicalSort(nodes: Node[], nodesMap) {
  // sort according to the topological order
  let indegree = new Map();
  nodes.forEach((node) => {
    indegree[node.id] = 0;
  });
  nodes.forEach((node) => {
    if (node.parentNode) {
      // actually the max indegree is 1
      indegree[node.parentNode] += 1;
    }
  });
  let queue: Node[] = [];
  nodes.forEach((node) => {
    if (!indegree[node.id]) {
      // push all 0 indegree nodes
      queue.push(node);
    }
  });
  let sorted: Node[] = [];
  while (queue.length > 0) {
    let node = queue.shift()!;
    sorted.push(node);
    if (node.parentNode) {
      indegree[node.parentNode]--;
      if (!indegree[node.parentNode]) {
        queue.push(nodesMap.get(node.parentNode));
      }
    }
  }
  sorted.reverse();
  return sorted;
}

/**
 * The Zustand store slice.
 */
export interface CanvasSlice {
  nodes: Node[];
  edges: Edge[];

  dragHighlight?: string;
  setDragHighlight: (dropHighlight: string) => void;
  removeDragHighlight: () => void;

  selectedPods: Set<string>;
  selectionParent: string | undefined;
  selectPod: (id: string, selected: boolean) => void;
  resetSelection: () => boolean;

  updateView: () => void;
  updateEdgeView: () => void;

  isPaneFocused: boolean;
  setPaneFocus: () => void;
  setPaneBlur: () => void;

  addNode: (
    type: "CODE" | "SCOPE" | "RICH",
    position: XYPosition,
    parent: string
  ) => void;

  pastingNodes?: Node[];
  headPastingNodes?: Set<string>;
  mousePos?: XYPosition | undefined;
  isPasting: boolean;
  pasteBegin: (position: XYPosition, pod: Pod, cutting: boolean) => void;
  pasteEnd: (position: XYPosition, cutting: boolean) => void;
  cancelPaste: (cutting: boolean) => void;
  onPasteMove: (mousePos: XYPosition) => void;

  isCutting: boolean;
  cuttingIds: Set<string>;
  cutBegin: (id: string) => void;
  cutEnd: (position: XYPosition, reactFlowInstance: ReactFlowInstance) => void;
  onCutMove: (mousePos: XYPosition) => void;
  cancelCut: () => void;

  adjustLevel: () => void;
  getScopeAtPos: ({ x, y }: XYPosition, exclude: string) => Node | undefined;
  moveIntoScope: (nodeId: string, scopeId: string) => void;
  moveIntoRoot: (nodeId: string) => void;
  tempUpdateView: ({ x, y }: XYPosition) => void;

  onNodesChange: (client: ApolloClient<any>) => OnNodesChange;
  onEdgesChange: (client: ApolloClient<any>) => OnEdgesChange;
  onConnect: (client: ApolloClient<any>) => OnConnect;

  node2children: Map<string, string[]>;
  buildNode2Children: () => void;
  autoLayout: () => void;
  autoForce: (scopeId: string) => void;
  autoForceGlobal: () => void;
}

export const createCanvasSlice: StateCreator<MyState, [], [], CanvasSlice> = (
  set,
  get
) => ({
  nodes: [],
  edges: [],

  setDragHighlight: (dragHighlight) => set({ dragHighlight }),
  removeDragHighlight: () => set({ dragHighlight: undefined }),

  // the nodes being cutting (on the top level)
  cuttingIds: new Set(),
  // all temporary nodes created during cutting/pasting
  pastingNodes: [],
  // the nodes being pasting (on the top level)
  headPastingNodes: new Set(),
  // current mouse position, used to update the pasting nodes on the top level when moving the mouse
  mousePos: undefined,

  isPaneFocused: false,

  selectedPods: new Set(),
  selectionParent: undefined,
  selectPod: (id, selected) => {
    set(
      produce((state: MyState) => {
        if (selected) {
          const p = get().getPod(id)?.parent;
          // if you select a node that has a different parent, clear all previous selections
          if (
            state.selectionParent !== undefined &&
            state.selectionParent !== p
          ) {
            state.selectedPods.clear();
          }
          state.selectionParent = p;
          state.selectedPods.add(id);
        } else {
          if (!state.selectedPods.delete(id)) return;
          if (state.selectedPods.size === 0) state.selectionParent = undefined;
        }
      })
    );
    get().updateView();
  },
  // clear all selections
  resetSelection: () => {
    if (get().selectedPods.size === 0) return false;
    set(
      produce((state: MyState) => {
        state.selectedPods.clear();
        state.selectionParent = undefined;
      })
    );
    return true;
  },

  /**
   * This function handles the real updates to the reactflow nodes to render.
   */
  updateView: () => {
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let selectedPods = get().selectedPods;
    // We have different sources of nodes:
    // 1. those from nodesMap, synced with other users
    let nodes = Array.from(nodesMap.values());
    // We don't use clientId anymore to filter pasting nodes. Instead, we filter
    // out the nodes that is being cutted. But for now, we are now hiding it,
    // but giving it a "cutting" className to add a dashed red border.
    //
    // .filter((node) => node.id !== get().cuttingId)
    nodes = nodes
      .sort((a: Node, b: Node) => a.data.level - b.data.level)
      .map((node) => ({
        ...node,
        style: {
          ...node.style,
          backgroundColor:
            node.type === "SCOPE" ? level2color[node.data.level] : undefined,
        },
        selected: selectedPods.has(node.id),
        // className: get().dragHighlight === node.id ? "active" : "",
        className: match(node.id)
          .with(get().dragHighlight, () => "active")
          .otherwise(() => undefined),
      }));
    // 2. show the temporary nodes, make the temporary nodes on the front-most
    nodes = nodes.concat(get().pastingNodes || []);

    const cursor = get().mousePos!;
    const movingNodes = get().headPastingNodes;
    if (cursor) {
      nodes = nodes.map((node) =>
        // update the position of top-level pasting nodes by the mouse position
        movingNodes?.has(node.id) ? { ...node, position: cursor } : node
      );
    }
    set({ nodes });
  },
  updateEdgeView: () => {
    const edgesMap = get().ydoc.getMap<Edge>("edges");
    set({ edges: Array.from(edgesMap.values()).filter((e) => e) });
  },

  addNode: (type, position, parent = "ROOT") => {
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let node = createNewNode(type, position);
    nodesMap.set(node.id, node);
    get().addPod({
      id: node.id,
      children: [],
      parent: "ROOT",
      type: node.type as "CODE" | "SCOPE" | "RICH",
      lang: "python",
      x: node.position.x,
      y: node.position.y,
      width: node.width!,
      height: node.height!,
      // For my local update, set dirty to true to push to DB.
      dirty: true,
      pending: true,
    });
    if (parent !== "ROOT") {
      // we don't assign its parent when created, because we have to adjust its position to make it inside its parent.
      get().moveIntoScope(node.id, parent);
    }
    get().updateView();
    // run auto-layout
    if (get().autoRunLayout) {
      get().autoForceGlobal();
    }
  },

  isPasting: false,
  isCutting: false,

  pasteBegin: (position, pod, cutting = false) => {
    // 1. create temporary nodes and pods
    const nodes = createTemporaryNode(pod, position);
    // 2. add the temporary pods to store.pods
    nodes.forEach(([node, p]) =>
      get().addPod({
        ...p,
        dirty: false,
      })
    );
    set({
      // Only headPastingNodes moves with the mouse, because the other temporary nodes are children of the headPastingNodes.
      // For now, we can have only one headPastingNode on the top level.
      // TODO: support multiple headPastingNodes on the top level when implementing multi-select copy-paste
      headPastingNodes: new Set([nodes[0][0].id]),
      // Distinguish the state of cutting or pasting
      isPasting: !cutting,
      isCutting: cutting,
      // But we need to keep all the temporary nodes in the pastingNodes list to render them.
      pastingNodes: nodes.map(([node, pod]) => node),
    });
    get().updateView();
  },
  onPasteMove: (mousePos: XYPosition) => {
    // When the mouse moves, only the top-level nodes move with the mouse. We don't have to update all the view.
    get().tempUpdateView(mousePos);
  },
  pasteEnd: (position, cutting = false) => {
    // on drop, make this node into nodesMap. The nodesMap.observer will updateView.
    const leadingNodes = get().headPastingNodes;
    const pastingNodes = get().pastingNodes;
    if (!pastingNodes || !leadingNodes) return;
    let nodesMap = get().ydoc.getMap<Node>("pods");

    // clear the temporary nodes and the pasting/cutting state
    set(
      produce((state) => {
        state.pastingNode = undefined;
        state.headPastingNodes = new Set();
        state.pastingNodes = [];
        state.mousePos = undefined;
        if (cutting) state.isCutting = false;
        else state.isPasting = false;
      })
    );

    pastingNodes.forEach((node) => {
      set(
        produce((state) => {
          let pod = state.pods[node!.id];
          if (leadingNodes?.has(node.id)) {
            pod.x = position.x;
            pod.y = position.y;
          }
          pod.dirty = true;
          // this flag triggers the addPods call when updating all dirty pods
          pod.pending = true;
        })
      );

      // insert all nodes to the yjs map
      nodesMap.set(node.id, {
        ...(leadingNodes?.has(node.id) ? { ...node, position } : node),
        style: { ...node.style, opacity: 1 },
        draggable: true,
      });
    });
    // update view
    get().updateView();

    // check if the final position located in another scope
    leadingNodes.forEach((id) => {
      let scope = getScopeAt(
        position.x,
        position.y,
        [id],
        get().nodes,
        nodesMap
      );
      if (scope && scope.id !== id) {
        get().moveIntoScope(id, scope.id);
      }
    });
  },
  cancelPaste: (cutting = false) => {
    const pastingNodes = get().pastingNodes || [];
    set(
      produce((state) => {
        // Remove pastingNode from store.
        state.pastingNodes = [];
        state.headPastingNodes = new Set();
        pastingNodes.forEach((node) => {
          delete state.pods[node!.id];
        });
        // Clear pasting data and update view.
        state.pastingNode = undefined;
        state.mousePos = undefined;
        if (cutting) state.isCutting = false;
        else state.isPasting = false;
      })
    );
    get().updateView();
  },

  //   checkDropIntoScope: (event, nodes: Node[], project: XYPosition=>XYPosition) => {},
  // cut will:
  // 1. hide the original node
  // 2. create a dummy node that move with cursor
  cutBegin: (id) => {
    const pod = get().clonePod(id);
    if (!pod) return;

    // Store only the top-level cut nodes, for now, it contains only one element. But we will support multi-select cut-paste in the future.
    set({ cuttingIds: new Set([id]) });
    get().pasteBegin({ x: pod.x, y: pod.y }, pod, true);
  },
  onCutMove: (mousePos) => {
    get().onPasteMove(mousePos);
  },
  // 3. on drop, delete the original node and create a new node
  cutEnd: (position, reactFlowInstance) => {
    const cuttingIds = get().cuttingIds;

    if (!cuttingIds) return;

    reactFlowInstance.deleteElements({
      nodes: Array.from(cuttingIds).map((id) => ({ id })),
    });

    set({ cuttingIds: new Set() });

    get().pasteEnd(position, true);
  },
  cancelCut: () => {
    set({ cuttingIds: new Set() });
    get().cancelPaste(true);
  },

  // NOTE: this does not mutate.
  getScopeAtPos: ({ x, y }, exclude) => {
    const nodesMap = get().ydoc.getMap<Node>("pods");
    return getScopeAt(x, y, [exclude], get().nodes, nodesMap);
  },

  adjustLevel: () => {
    // adjust the levels of all nodes, using topoSort
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let nodes = Array.from(nodesMap.values());
    nodes = topologicalSort(nodes, nodesMap);
    // update nodes' level
    nodes.forEach((node) => {
      let newLevel = node.parentNode
        ? nodesMap.get(node.parentNode!)!.data.level + 1
        : 0;
      if (node.data.level !== newLevel) {
        nodesMap.set(node.id, {
          ...node,
          data: {
            ...node.data,
            level: newLevel,
          },
        });
      }
    });
  },
  moveIntoRoot: (nodeId: string) => {
    console.log("Moving into root", nodeId);
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let node = nodesMap.get(nodeId);
    if (!node) {
      console.warn("Node not found", node);
      return;
    }
    let newNode: Node = {
      ...node,
      parentNode: undefined,
      data: {
        ...node.data,
        level: 0,
      },
    };
    nodesMap.set(node.id, newNode);
    // update zustand & db
    get().setPodGeo(node.id, { parent: "ROOT" }, true);
    get().adjustLevel();
    // update view
    get().updateView();
  },

  moveIntoScope: (nodeId: string, scopeId: string) => {
    console.log(`Moving ${nodeId} into scope ${scopeId}`);
    // move a node into a scope.
    // 1. update the node's parentNode & position
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let node = nodesMap.get(nodeId);
    let scope = nodesMap.get(scopeId);
    if (!node || !scope) {
      console.warn("Node or scope not found", node, scope);
      return;
    }
    // let [x, y] = getAbsPos(node, nodesMap);
    // let position = getNodePositionInsideParent(node, scope, { x, y });

    // FIXME: since richNode and codeNode doesn't have height when it's created, we have to pass its height manually in case crash.
    const nodeHeight = get().getPod(nodeId)?.height || 0;
    let position = getNodePositionInsideScope(
      node,
      scope,
      nodesMap,
      nodeHeight
    );
    let newNode: Node = {
      ...node,
      position,
      parentNode: scope.id,
      data: {
        ...node.data,
        level: scope.data.level + 1,
      },
    };
    // update peer
    nodesMap.set(node.id, newNode);
    // update zustand & db
    get().setPodGeo(node.id, { parent: scope.id, ...position }, true);
    get().adjustLevel();
    // update view
    get().updateView();
  },

  tempUpdateView: (position) => {
    const movingNodes = get().headPastingNodes;
    set({
      mousePos: position,
      nodes: get().nodes.map((node) =>
        movingNodes?.has(node.id) ? { ...node, position } : node
      ),
    });
  },

  // I should modify nodesMap here
  onNodesChange: (client) => (changes: NodeChange[]) => {
    let nodesMap = get().ydoc.getMap<Node>("pods");
    const nodes = get().nodes;

    // I think this place update the node's width/height
    const nextNodes = applyNodeChanges(changes, nodes);

    changes.forEach((change) => {
      switch (change.type) {
        case "reset":
          break;
        case "add":
          throw new Error("Add node should not be handled here");
        case "select":
          get().selectPod(change.id, change.selected);
          break;
        case "dimensions":
          {
            // Since CodeNode doesn't have a height, this dimension change will
            // be filed for CodeNode at the beginning or anytime the node height
            // is changed due to content height changes.
            const node = nextNodes.find((n) => n.id === change.id);
            if (!node) throw new Error("Node not found");

            let geoData = {
              parent: node.parentNode ? node.parentNode : "ROOT",
              x: node.position.x,
              y: node.position.y,
              width: node.width!,
              height: node.height!,
            };
            // console.log(
            //   `node ${change.id} dimension changed, geoData ${JSON.stringify(
            //     geoData
            //   )}`
            // );
            // If Yjs doesn't have the node, it means that it's a cutting/pasting
            // node. We won't add it to Yjs here.
            if (
              get()
                .pastingNodes?.map((n) => n.id)
                .includes(change.id)
            ) {
              if (nodesMap.has(change.id)) {
                throw new Error(
                  "Node is cutting/pasting node but exists in Yjs"
                );
              }
              // still, we need to set the node, otherwise the height is not set.
              // update local
              set(
                produce((state: MyState) => {
                  state.pastingNodes = state.pastingNodes?.map((n) =>
                    n.id === change.id ? node : n
                  );
                })
              );
              // update local
              get().setPodGeo(node.id, geoData, false);
            } else {
              if (!nodesMap.has(change.id)) {
                throw new Error("Node not found in yjs.");
              }
              nodesMap.set(change.id, node);
              // update local
              get().setPodGeo(node.id, geoData, true);
            }
          }
          break;
        case "position":
          const node = nextNodes.find((n) => n.id === change.id);
          if (!node) throw new Error("Node not found");
          // If Yjs doesn't have the node, it means that it's a cutting/pasting
          // node. We won't add it to Yjs here.
          let geoData = {
            parent: node.parentNode ? node.parentNode : "ROOT",
            x: node.position.x,
            y: node.position.y,
            width: node.width!,
            height: node.height!,
          };

          if (!nodesMap.has(change.id)) {
            throw new Error("Node not found in yjs.");
          }
          nodesMap.set(change.id, node);
          // update local
          get().setPodGeo(node.id, geoData, true);

          break;
        case "remove":
          // FIXME Would reactflow fire multiple remove for all nodes? If so,
          // do they have a proper order? Seems yes.
          // remove from yjs
          nodesMap.delete(change.id);
          // remove from store
          get().deletePod(client, { id: change.id });
          break;
        default:
          // should not reach here.
          throw new Error("Unknown change type");
      }
    });
    get().updateView();
  },
  onEdgesChange: (client) => (changes: EdgeChange[]) => {
    // TODO sync with remote peer
    const edgesMap = get().ydoc.getMap<Edge>("edges");
    // apply the changes. Especially for the "select" change.
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
    // FIXME this will create edge with IDs. But I probably would love to control the IDs to save in DB.
    changes.forEach((change) => {
      // console.log("=== onEdgeChange", change.type, change);
      // TODO update nodesMap to sync with remote peers
      switch (change.type) {
        case "add":
          break;
        case "remove":
          const edge = edgesMap.get(change.id);
          if (!edge) throw new Error("Edge not found");
          remoteDeleteEdge({
            source: edge.source,
            target: edge.target,
            client,
          });
          edgesMap.delete(change.id);
          break;
        case "reset":
          break;
        case "select":
          break;
        default:
          throw new Error("NO REACH");
      }
    });
  },
  onConnect: (client) => (connection: Connection) => {
    const edgesMap = get().ydoc.getMap<Edge>("edges");
    if (!connection.source || !connection.target) return null;
    remoteAddEdge({
      source: connection.source,
      target: connection.target,
      client,
    });
    const edge = {
      id: `${connection.source}_${connection.target}`,
      source: connection.source,
      sourceHandle: "top",
      target: connection.target,
      targetHandle: "top",
    };
    edgesMap.set(edge.id, edge);
    get().updateEdgeView();
  },
  setPaneFocus: () => set({ isPaneFocused: true }),
  setPaneBlur: () => set({ isPaneFocused: false }),
  /**
   * This node2children is maintained with the canvas reactflow states, not with
   * the pods. This mapping may be used by other components, e.g. the runtime.
   *
   * TODO we should optimize the performance of this function, maybe only update
   * the mapping when the structure is changed.
   */
  node2children: new Map<string, string[]>(),
  buildNode2Children: () => {
    // build a map from node to its children
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let nodes: Node[] = Array.from(nodesMap.values());
    let node2children = new Map<string, string[]>();
    nodes.forEach((node) => {
      if (!node2children.has(node.id)) {
        node2children.set(node.id, []);
      }
      if (node.parentNode) {
        if (!node2children.has(node.parentNode)) {
          node2children.set(node.parentNode, []);
        }
        node2children.get(node.parentNode)?.push(node.id);
      }
    });
    set({ node2children });
  },
  autoLayout: () => {
    // Auto layout the nodes.
    // Find all the scope nodes, and change its width and height to fit its children nodes.
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let nodes: Node[] = Array.from(nodesMap.values());
    get().buildNode2Children();
    // fit the children.
    nodes
      // sort the children so that the inner scope gets processed first.
      .sort((a: Node, b: Node) => b.data.level - a.data.level)
      .forEach((node) => {
        let newSize = fitChildren(node, get().node2children, nodesMap);
        if (newSize === null) return;
        let { x, y, width, height } = newSize;
        let newNode = {
          ...node,
          position: {
            x: node.position.x + x,
            y: node.position.y + y,
          },
          width,
          height,
          style: {
            ...node.style,
            width,
            height,
          },
        };
        nodesMap.set(node.id, newNode);
        // I actually need to set the children's position as well, because they are relative to the parent.
        let children = get().node2children.get(node.id);
        children?.forEach((child) => {
          let n = nodesMap.get(child)!;
          let newChild = {
            ...n,
            position: {
              x: n.position.x - x,
              y: n.position.y - y,
            },
          };
          nodesMap.set(child, newChild);
        });
      });
    // trigger update to the db
    // get the most recent nodes
    nodes = Array.from(nodesMap.values());
    nodes.forEach((node) => {
      // trigger update to the DB
      let geoData = {
        parent: node.parentNode ? node.parentNode : "ROOT",
        x: node.position.x,
        y: node.position.y,
        width: node.width!,
        height: node.height!,
      };
      get().setPodGeo(node.id, geoData, true);
    });
    // update the view
    get().updateView();
  },
  autoForceGlobal: () => {
    // get all scopes,
    let nodesMap = get().ydoc.getMap<Node>("pods");
    let nodes: Node[] = Array.from(nodesMap.values());
    get().buildNode2Children();
    nodes
      // sort the children so that the inner scope gets processed first.
      .sort((a: Node, b: Node) => b.data.level - a.data.level)
      .forEach((node) => {
        if (node.type === "SCOPE") {
          get().autoForce(node.id);
        }
      });
    // Applying on ROOT scope is not ideal.
    get().autoForce("ROOT");
  },
  /**
   * Use d3-force to auto layout the nodes.
   */
  autoForce: (scopeId) => {
    // 1. get all the nodes and edges in the scope
    // 2. get
    type NodeType = {
      id: string;
      x: number;
      y: number;
      r: number;
      width: number;
      height: number;
    };
    const nodes = get().nodes.filter(
      (node) => node.parentNode === (scopeId === "ROOT" ? undefined : scopeId)
    );
    if (nodes.length == 0) return;
    const edges = get().edges;
    const tmpNodes: NodeType[] = nodes.map((node) => ({
      id: node.id,
      x: node.position.x + (node.width! + node.height!) / 2,
      y: node.position.y + (node.width! + node.height!) / 2,
      r: (node.width! + node.height!) / 2,
      width: node.width!,
      height: node.height!,
    }));
    const tmpEdges = edges.map((edge) => ({
      source: edge.source,
      source0: 0,
      target: edge.target,
      target0: 1,
    }));
    const nodesMap = get().ydoc.getMap<Node>("pods");
    // 2. construct a D3 tree for the nodes and their connections
    // initialize the tree layout (see https://observablehq.com/@d3/tree for examples)
    // const hierarchy = stratify<Node>()
    //   .id((d) => d.id)
    //   // get the id of each node by searching through the edges
    //   // this only works if every node has one connection
    //   .parentId((d: Node) => edges.find((e: Edge) => e.target === d.id)?.source)(
    //   nodes
    // );
    const simulation = forceSimulation<NodeType>(tmpNodes)
      // .force(
      //   "link",
      //   forceLink(tmpEdges)
      //     .id((d: any) => d.id)
      //     .distance(20)
      //     .strength(0.5)
      // )
      // .force("charge", forceManyBody().strength(-1000))
      // .force("x", forceX())
      // .force("y", forceY())
      .force(
        "collide",
        forceCollide().radius((d: any) => d.r)
      )
      // .force("link", d3.forceLink(edges).id(d => d.id))
      // .force("charge", d3.forceManyBody())
      // .force("center", forceCenter(0, 0))
      .stop();
    simulation.tick(3000);
    tmpNodes.forEach((node) => {
      node.x -= (node.width! + node.height!) / 2;
      node.y -= (node.width! + node.height!) / 2;
    });
    // The nodes will all have new positions now. I'll need to make the graph to be top-left, i.e., the leftmost is 20, the topmost is 20.
    // get the min x and y
    let x1s = tmpNodes.map((node) => node.x);
    let minx = Math.min(...x1s);
    let y1s = tmpNodes.map((node) => node.y);
    let miny = Math.min(...y1s);
    // calculate the offset, leave 50 padding for the scope.
    const offsetx = 50 - minx;
    const offsety = 50 - miny;
    // move the nodes
    tmpNodes.forEach((node) => {
      node.x += offsetx;
      node.y += offsety;
    });
    // Apply the new positions
    // TODO need to transform the nodes to the center of the scope.
    tmpNodes.forEach(({ id, x, y }) => {
      // FIXME I should assert here.
      if (nodesMap.has(id)) {
        nodesMap.set(id, {
          ...nodesMap.get(id)!,
          // position: { x: x + scope!.position!.x, y: y + scope!.position!.y },
          position: { x, y },
        });
      }
    });

    if (scopeId !== "ROOT") {
      // update the scope's size to enclose all the nodes
      x1s = tmpNodes.map((node) => node.x);
      minx = Math.min(...x1s);
      y1s = tmpNodes.map((node) => node.y);
      miny = Math.min(...y1s);
      const x2s = tmpNodes.map((node) => node.x + node.width!);
      const maxx = Math.max(...x2s);
      const y2s = tmpNodes.map((node) => node.y + node.height!);
      const maxy = Math.max(...y2s);
      const scope = nodesMap.get(scopeId);
      nodesMap.set(scopeId, {
        ...scope!,
        width: maxx - minx + 100,
        height: maxy - minx + 100,
        style: {
          ...scope!.style,
          width: maxx - minx + 100,
          height: maxy - minx + 100,
        },
      });
    }

    // trigger update to the db
    // get the most recent nodes
    let newNodes = Array.from(nodesMap.values());
    newNodes.forEach((node) => {
      // trigger update to the DB
      let geoData = {
        parent: node.parentNode ? node.parentNode : "ROOT",
        x: node.position.x,
        y: node.position.y,
        width: node.width!,
        height: node.height!,
      };
      get().setPodGeo(node.id, geoData, true);
    });

    get().updateView();
  },
});

/**
 * Compute the rectangle of that is tightly fit to the children.
 * @param node
 * @param node2children
 * @param nodesMap
 * @returns {x,y,width,height}
 */
function fitChildren(
  node: Node,
  node2children,
  nodesMap
): null | { x: number; y: number; width: number; height: number } {
  if (node.type !== "SCOPE") return null;
  // This is a scope node. Get all its children and calculate the x,y,width,height to tightly fit its children.
  let children = node2children.get(node.id);
  // If no children, nothing is changed.
  if (children.length === 0) return null;
  // These positions are actually relative to the parent node.
  let x1s = children.map((child) => nodesMap.get(child)!.position.x);
  let minx = Math.min(...x1s);
  let y1s = children.map((child) => nodesMap.get(child)!.position.y);
  let miny = Math.min(...y1s);
  let x2s = children.map((child) => {
    let n = nodesMap.get(child)!;
    return n.position.x + n.width!;
  });
  let maxx = Math.max(...x2s);
  let y2s = children.map((child) => {
    let n = nodesMap.get(child)!;
    return n.position.y + n.height!;
  });
  let maxy = Math.max(...y2s);
  let width = maxx - minx;
  let height = maxy - miny;
  return {
    // leave a 50 padding for the scope.
    x: minx - 50,
    y: miny - 50,
    width: width + 100,
    height: height + 100,
  };
}

async function remoteAddEdge({ client, source, target }) {
  const mutation = gql`
    mutation addEdge($source: ID!, $target: ID!) {
      addEdge(source: $source, target: $target)
    }
  `;
  await client.mutate({
    mutation,
    variables: {
      source,
      target,
    },
  });
  return true;
}

async function remoteDeleteEdge({ client, source, target }) {
  const mutation = gql`
    mutation deleteEdge($source: ID!, $target: ID!) {
      deleteEdge(source: $source, target: $target)
    }
  `;
  await client.mutate({
    mutation,
    variables: {
      source,
      target,
    },
  });
  return true;
}