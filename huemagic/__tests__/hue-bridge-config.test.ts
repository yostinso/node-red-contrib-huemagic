jest.mock("node-red");
jest.mock("../utils/api");
jest.mock("events");
jest.mock("dayjs", () => {
    const dayjs = jest.requireActual("dayjs");
    return jest.fn().mockImplementation((...args) => dayjs(...args));
});

import _dayjs from "dayjs";
import { EventEmitter as _EventEmitter } from "events";
import { Node } from "node-red";
import { resourceUsage } from "process";
import { HueBridge, HueBridgeDef } from "../hue-bridge-config";
import API from "../utils/api";
import { Bridge } from "../utils/types/api/bridge";
import { Resource } from "../utils/types/api/resource";
import { RulesV1ResponseItem } from "../utils/types/api/rules";
import { ExpandedResource, expandedResources, ExpandedServiceOwnerResource } from "../utils/types/expanded/resource";
import { ServiceOwnerResourceType } from "../utils/types/resources/generic";
import { defaultBridgeConfig } from "../utils/__fixtures__/api/config";
import { makeEvent } from "../utils/__fixtures__/api/event";
import { defaultResources, makeButtonGroup, makeDevice, makeLight } from "../utils/__fixtures__/api/resources";
import { defaultRules } from "../utils/__fixtures__/api/rules";


const EventEmitter = _EventEmitter as jest.MockedClass<typeof _EventEmitter>;
const dayjs = jest.mocked(_dayjs);

const nodeLog = jest.fn().mockName("nodeLog");
const nodeWarn = jest.fn().mockName("nodeWarn");

const node: Node = {
    log: nodeLog,
    warn: nodeWarn
} as unknown as Node;


const BRIDGE = "bridge-" + Math.random();
const BRIDGE_KEY = "key-" + Math.random();
const config: HueBridgeDef = {
    bridge: BRIDGE,
    key: BRIDGE_KEY,
    id: "bridge",
    type: "bridge",
    name: "my bridge",
    z: "wat"
}
function mockInstantTimeout() {
    jest.useFakeTimers();
    const mockTimeout = jest.spyOn(global, "setTimeout").mockImplementation(
        (cb, ms) => {
            const t = setImmediate(cb);
            jest.runAllTimers();
            return t as unknown as NodeJS.Timeout;
        }
    );
    return mockTimeout;
}

type FunctionPropertyNames<T> = { [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never }[keyof T] & string;
function mockRunMethodOnceAndThenNoop<T extends {}, M extends FunctionPropertyNames<Required<T>>>(object: T, method: M) {
    const orig = (object as any)[method];
    const mock = jest.spyOn(object, method);
    mock.mockImplementationOnce(orig);
    mock.mockResolvedValue(true as any);
    return mock;
}

describe(HueBridge, () => {
    beforeEach(() => {
        nodeLog.mockClear();
        nodeWarn.mockClear();
    });
    it("should be constructable", () => {
        expect(() => new HueBridge(node, config)).not.toThrow();
    });

    describe("after construction", () => {
        let bridgeNode!: HueBridge;
        beforeEach(() => {
            bridgeNode = new HueBridge(node, config);
        });

        describe(HueBridge.prototype.start, () => {
            it("should retry a connection on connection failure", async () => {
                jest.useFakeTimers();
                mockInstantTimeout();

                // Mock .start to just resolve(true) after running the first time
                const mockStart = mockRunMethodOnceAndThenNoop(bridgeNode, "start");

                // Trigger an error so we retry
                jest.mocked(API.init).mockRejectedValueOnce("error message");

                await bridgeNode.start();
                expect(nodeLog).toBeCalledTimes(2);
                expect(nodeLog).toBeCalledWith("error message");

                jest.useRealTimers();
            });
            it("should not retry when the node is disabled", () => {
                bridgeNode.enabled = false;
                jest.mocked(API.init).mockRejectedValueOnce("error message");
                const result = expect(bridgeNode.start()).resolves.toBe(false);
                return result;
            });
            it("should fetch all resources", async () => {
                const getAllResourcesMock = jest.spyOn(bridgeNode, "getAllResources");
                await bridgeNode.start();
                expect(getAllResourcesMock).toBeCalled();
            })
            it("should emit initial resources", async () => {
                const pushStateMock = jest.spyOn(bridgeNode, "pushUpdatedState")
                pushStateMock.mockClear();

                await bridgeNode.start();
                pushStateMock.mockReturnValue();
                let expectedResourceIds = [
                    ...defaultResources.map((r) => r.id),
                    "bridge",
                    ...Object.keys(defaultRules).map((id) => `rule_${id}`)
                ].sort();
                let emittedResourceIds = pushStateMock.mock.calls.map((c) => c[0].id).sort();
                expect(emittedResourceIds).toEqual(expectedResourceIds);
            });
            it("should subscribe to events and kick off firmware updates", async () => {
                await bridgeNode.start();
                expect(API.subscribe).toBeCalled();
                expect(API.setBridgeUpdate).toBeCalled();
            })
        })

        describe(HueBridge.prototype.getBridgeInformation, () => {
            it("should fetch and generate a bridge config", () => {
                return expect(bridgeNode.getBridgeInformation()).resolves.toEqual(expect.objectContaining({
                    ...defaultBridgeConfig,
                    id: "bridge",
                    id_v1: "/config",
                    type: "bridge",
                    updated: expect.stringMatching(/.*T.*/)
                }));
            });
            it("should not replace the bridge entry if replaceResources is true", async () => {
                await bridgeNode.getBridgeInformation();
                expect(bridgeNode.resources["bridge"]).toBeUndefined();
            });
            it("should replace the bridge entry if replaceResources is true", async () => {
                await bridgeNode.getBridgeInformation(true);
                expect(bridgeNode.resources["bridge"]).toEqual(expect.objectContaining({
                    type: "bridge",
                    id: "bridge"
                }));
            });
            it("should reject on API failure", () => {
                jest.mocked(API.config).mockRejectedValueOnce("error message");
                const result = expect(bridgeNode.getBridgeInformation()).rejects.toEqual("error message");
                return result;
            });
        });
        describe(HueBridge.prototype.getAllResources, () => {
            it("should include the bridge in the results", () => {
                jest.spyOn(bridgeNode, "getBridgeInformation").mockImplementation(() => {
                    return Promise.resolve({ type: "bridge", id: "mockBridge" }) as Promise<Bridge>;
                });
                let resources = bridgeNode.getAllResources();
                return expect(resources).resolves.toContainEqual(expect.objectContaining({
                    id: "mockBridge",
                    type: "bridge"
                }));
            });
            it("should include rules in the results", () => {
                jest.mocked(API.rules).mockResolvedValueOnce({
                    "my_rule": { name: "My Rule", status: "mock status" } as RulesV1ResponseItem
                });
                let resources = bridgeNode.getAllResources();
                return expect(resources).resolves.toContainEqual(expect.objectContaining({
                    name: "My Rule",
                    type: "rule",
                    id: "rule_my_rule",
                    id_v1: "/rules/my_rule",
                    status: "mock status"
                }));
            });
            it("should include device resources in the results", () => {
                jest.mocked(API.getAllResources).mockResolvedValueOnce([
                    { id: "my_device", type: "device" }
                ])
                let resources = bridgeNode.getAllResources();
                return expect(resources).resolves.toContainEqual(expect.objectContaining({
                    id: "my_device", type: "device"
                }));
            });
            it("should contain everything as fetched from the API", async () => {
                // Integration test
                let resources = await bridgeNode.getAllResources();
                expect(resources).toContainEqual(expect.objectContaining(defaultBridgeConfig))
                Object.entries(defaultRules).forEach(([id, rule]) => {
                    expect(resources).toContainEqual(expect.objectContaining({
                        ...rule,
						id: `rule_${id}`,
						id_v1: `/rules/${id}`,
                        type: "rule"
                    }))
                });
                defaultResources.forEach((resource) => {
                    expect(resources).toContainEqual(expect.objectContaining(resource))
                });
            });
            it("should be true that all entries have id, id_v1, and type", async () => {
                let resources = await bridgeNode.getAllResources();
                resources.forEach((resource) => {
                    expect(resource).toHaveProperty("id");
                    expect(resource).toHaveProperty("id_v1");
                    expect(resource).toHaveProperty("type");
                });
            });
            it("should reject on API failure", () => {
                jest.mocked(API.config).mockRejectedValueOnce("error message");
                const result = expect(bridgeNode.getAllResources()).rejects.toEqual("error message");
                return result;
            });
        });

        describe(HueBridge.prototype.pushUpdatedState, () => {
            const msg = {
                id: "my_resource",
                type: "device",
                updatedType: "device",
                services: [],
                suppressMessage: false
            };
            beforeAll(() => {
                EventEmitter.mockReset();
            });
            afterEach(() => {
                EventEmitter.mockReset();
            })

            const mockEmit = () => {
                expect(EventEmitter.mock.instances.length).toBe(1);
                const events = EventEmitter.mock.instances[0];
                const emit = jest.mocked(events.emit);
                emit.mockReturnValue(true); // noop events
                return emit;
            }

            it("should emit events for updated resources", () => {
                const resource: ExpandedResource<"device"> = {
                    id: "my_resource",
                    type: "device"
                }

                const emit = mockEmit();
                bridgeNode.pushUpdatedState(resource, "device");

                expect(emit).toBeCalledTimes(2);
                expect(emit).toBeCalledWith("bridge_my_resource", msg);
                expect(emit).toBeCalledWith("bridge_globalResourceUpdates", msg);
            });
            it("should set suppressMessage in the generated message", () => {
                const resource: ExpandedResource<"device"> = {
                    id: "my_resource",
                    type: "device"
                }

                const emit = mockEmit();
                bridgeNode.pushUpdatedState(resource, "device");
                expect(emit.mock.calls).toEqual([
                    [ expect.anything(), expect.objectContaining({ suppressMessage: false }) ],
                    [ expect.anything(), expect.objectContaining({ suppressMessage: false }) ],
                ])

                emit.mockClear();
                bridgeNode.pushUpdatedState(resource, "device", true);
                expect(emit.mock.calls).toEqual([
                    [ expect.anything(), expect.objectContaining({ suppressMessage: true }) ],
                    [ expect.anything(), expect.objectContaining({ suppressMessage: true }) ],
                ])
            })
            describe("if the resource has services", () => {
                it("should include services in the messages", () => {
                    const resource: ExpandedServiceOwnerResource<"device"> = {
                        id: "my_resource",
                        type: "device",
                        services: {
                            "button": { "my_button": { id: "my_button", type: "button" } },
                            "device": { "my_device": { id: "my_device", type: "device" } }
                        }
                    };
                    const emit = mockEmit();
                    bridgeNode.pushUpdatedState(resource, "device");

                    const serviceMsg = {
                        ...msg,
                        services: expect.arrayContaining(["my_button", "my_device"])
                    };
                    
                    expect(emit).toBeCalledTimes(2);
                    expect(emit).toBeCalledWith("bridge_my_resource", serviceMsg);
                    expect(emit).toBeCalledWith("bridge_globalResourceUpdates", serviceMsg);
                });
                it("should emit changes to groups if services are members of a group", () => {
                    const resource: ExpandedServiceOwnerResource<"device"> = {
                        id: "my_resource",
                        type: "device",
                        services: {
                            "button": { "my_button": { id: "my_button", type: "button" } },
                            "device": { "my_device": { id: "my_device", type: "device" } }
                        }
                    };

                    bridgeNode.groupsOfResources["my_resource"] = [ "zone_id" ];

                    const groupMsg = {
                        id: "zone_id",
                        type: "group",
                        updatedType: "device",
                        services: [],
                        suppressMessage: false
                    };

                    const emit = mockEmit();
                    bridgeNode.pushUpdatedState(resource, "device");

                    expect(emit).toBeCalledTimes(4);
                    expect(emit).nthCalledWith(3, "bridge_zone_id", groupMsg);
                    expect(emit).nthCalledWith(4, "bridge_globalResourceUpdates", groupMsg);
                });
            });
        });

        describe(HueBridge.prototype.emitInitialStates, () => {
            it("should not do anything on the current tick", async () => {
                jest.useFakeTimers();
                const pushStateMock = jest.spyOn(bridgeNode, "pushUpdatedState")
                pushStateMock.mockReturnValue();

                bridgeNode.resources["my_resource"] = {
                    id: "my_resource",
                    type: "device",
                };

                // Don't emit events immediately
                const promise = bridgeNode.emitInitialStates();
                expect(pushStateMock).not.toBeCalled();

                // But do in the next event loop
                jest.runAllTimers();
                await promise;
                expect(pushStateMock).toBeCalled();

                
                jest.clearAllTimers();
                jest.useRealTimers();
            })
            it("should emit an event for every resource", () => {
                    jest.useFakeTimers();
                    const pushStateMock = jest.spyOn(bridgeNode, "pushUpdatedState")
                    pushStateMock.mockReturnValue();
                    const r1: ExpandedResource<"device"> = {
                        id: "my_resource1",
                        type: "device",
                    };
                    const r2: ExpandedResource<"device"> = {
                        id: "my_resource1",
                        type: "device",
                    };
                    bridgeNode.resources["my_resource1"] = r1;
                    bridgeNode.resources["my_resource2"] = r2;

                    const promise = bridgeNode.emitInitialStates();
                    jest.runAllTimers();

                    expect(pushStateMock).toBeCalledTimes(2);
                    expect(pushStateMock.mock.calls).toContainEqual([ r1, "device", true ]);
                    expect(pushStateMock.mock.calls).toContainEqual([ r2, "device", true ]);
                    
                    jest.clearAllTimers();
                    jest.useRealTimers();

                    return promise;
            });
        });

        describe(HueBridge.prototype.subscribeToBridgeEventStream, () => {
            it("should subscribe to bridge events", () => {
                jest.mocked(API.subscribe).mockReturnValueOnce(Promise.resolve(true));
                bridgeNode.subscribeToBridgeEventStream();
                expect(API.subscribe).toBeCalledWith(config, bridgeNode.handleBridgeEvent);
            });
        });
        describe(HueBridge.prototype.handleBridgeEvent, () => {
            beforeEach(() => {
                jest.spyOn(bridgeNode, "pushUpdatedState").mockReturnValue();
            });
            it("shouldn't update state or events if the event contains no new info", () => {
                const event = makeEvent("my_event", "update", makeDevice("new_device"));
                const resources = { ...bridgeNode.resources };

                bridgeNode.handleBridgeEvent([ event ]);
                
                expect(bridgeNode.pushUpdatedState).not.toBeCalled();
                expect(bridgeNode.resources).toEqual(resources);
            });
            it("should do nothing for events with no differences", () => {
                const device = makeDevice("new_device");
                bridgeNode.resources[device.id] = device;
                const event = makeEvent("my_event", "update", device);
                const resources = { ...bridgeNode.resources };

                bridgeNode.handleBridgeEvent([ event ]);

                expect(bridgeNode.pushUpdatedState).not.toBeCalled();
                expect(bridgeNode.resources).toEqual(resources);
            });
            it("should update the eventing resource and send an event for an unowned resource", () => {
                const now = dayjs();

                const device = makeDevice("new_device", "Old Name");
                bridgeNode.resources[device.id] = device;
                const event = makeEvent("my_event", "update", {
                    ...device,
                    metadata: { ...device.metadata, name: "Something New" }
                });

                dayjs.mockReturnValueOnce(now);
                bridgeNode.handleBridgeEvent([ event ]);

                expect(bridgeNode.pushUpdatedState).toBeCalled();
                expect(bridgeNode.resources).toEqual({
                    new_device: expect.objectContaining({
                        metadata: expect.objectContaining({ name: "Something New" }),
                        updated: now.format()
                    })
                });
            });
            describe("if the eventing resource has a parent", () => {
                const putExpandedResources = (bridge: HueBridge, ...resources: Resource<any>[]) => {
                    const [expanded, grouped] = expandedResources(resources);
                    Object.entries(expanded).forEach(([id, res]) => bridge.resources[id] = res);
                    Object.entries(grouped).forEach(([id, grp]) => bridge.groupsOfResources[id] = grp);
                }
                it("should error if the parent doesn't exist", () => {
                    const device = makeLight("my_light", "Something Old", {
                        rid: "this_doesn't_exist",
                        rtype: "device"
                    });
                    
                    bridgeNode.resources[device.id] = device;
                    const event = makeEvent("my_event", "update", {
                        ...device,
                        metadata: { ...device.metadata, name: "Something New" }
                    });
                    expect(() => bridgeNode.handleBridgeEvent([ event ])).toThrowError(/No resource entry/);
                });
                it("should notify the parent, not the resource directly", () => {
                    const [ group, buttons ] = makeButtonGroup("Button Group", 4);
                    putExpandedResources(bridgeNode, group, ...buttons);

                    const button = buttons[0];
                    const event = makeEvent("my_event", "update", {
                        ...button,
                        button: { last_event: "initial_press" }
                    });
                    
                    bridgeNode.handleBridgeEvent([ event ]);
                    expect(bridgeNode.pushUpdatedState).toBeCalledTimes(1);
                    expect(bridgeNode.pushUpdatedState).toBeCalledWith(expect.objectContaining({
                        id: group.id,
                        services: expect.objectContaining({
                            button: expect.objectContaining({
                                [buttons[0].id]: expect.anything(),
                                [buttons[1].id]: expect.anything(),
                                [buttons[2].id]: expect.anything(),
                                [buttons[3].id]: expect.anything(),
                            })
                        })
                    }), "button");
                });
                it("should keep only the pressed button state and clear others off the parent if it's a button", () => {
                    const [ group, buttons ] = makeButtonGroup("Button Group", 4);
                    buttons.forEach((btn) => { btn.button = { last_event: "initial_press" }; })
                    putExpandedResources(bridgeNode, group, ...buttons);

                    const button = buttons[0];
                    const event = makeEvent("my_event", "update", {
                        ...button,
                        button: { last_event: "short_release"}
                    });
                    
                    bridgeNode.handleBridgeEvent([ event ]);
                    expect(bridgeNode.pushUpdatedState).toBeCalledTimes(1);
                    let expandedGroup = bridgeNode.resources[group.id] as ExpandedServiceOwnerResource<"device">;
                    expect(bridgeNode.pushUpdatedState).toBeCalledWith(expandedGroup, "button");
                    
                    expect(expandedGroup.services?.button).toEqual(expect.objectContaining({
                        [buttons[0].id]: expect.objectContaining({ button: { last_event: "short_release" } }),
                        [buttons[1].id]: expect.not.objectContaining({ button: expect.anything() }),
                        [buttons[2].id]: expect.not.objectContaining({ button: expect.anything() }),
                        [buttons[3].id]: expect.not.objectContaining({ button: expect.anything() }),
                    }))
                });
                it("should warn but continue if this doesn't seem like an expected owned type", () => {
                    jest.spyOn(console, "warn").mockReturnValueOnce();
                    const [ group, buttons ] = makeButtonGroup("Button Group", 4);
                    putExpandedResources(bridgeNode, group, ...buttons);

                    bridgeNode.resources[group.id].type = "motion";
                    
                    const button = buttons[0];
                    const event = makeEvent("my_event", "update", {
                        ...button,
                        button: { last_event: "short_release" }
                    });
                    bridgeNode.handleBridgeEvent([ event ]);
                    expect(bridgeNode.pushUpdatedState).toBeCalledTimes(1);

                    expect(console.warn).toBeCalledWith(expect.stringContaining("not an expected owner type"));

                    let expandedGroup = bridgeNode.resources[group.id] as ExpandedServiceOwnerResource<ServiceOwnerResourceType>; // This is a lie; it's a "motion"
                    expect(expandedGroup.services?.button).toEqual(expect.objectContaining({
                        [buttons[0].id]: expect.objectContaining({ button: { last_event: "short_release" } }),
                        [buttons[1].id]: expect.not.objectContaining({ button: expect.anything() }),
                        [buttons[2].id]: expect.not.objectContaining({ button: expect.anything() }),
                        [buttons[3].id]: expect.not.objectContaining({ button: expect.anything() }),
                    }))
                });
            });
        });

        describe(HueBridge.prototype.keepUpdated, () => {
            it("should do nothing if updates are disabled", () => {
                bridgeNode = new HueBridge(node, {
                    ...config,
                    disableupdates: true
                });
                jest.spyOn(bridgeNode, "subscribeToBridgeEventStream").mockReturnValue();
                bridgeNode.keepUpdated();
                expect(bridgeNode.subscribeToBridgeEventStream).not.toBeCalled();
            });
            it("should subscribe to events if not disabled", () => {
                jest.spyOn(bridgeNode, "subscribeToBridgeEventStream").mockReturnValue();
                bridgeNode.keepUpdated();
                expect(bridgeNode.subscribeToBridgeEventStream).toBeCalled();
            });
        });

        describe(HueBridge.prototype.autoUpdateFirmware, () => {
            it("should do nothing if config.autoupdates === false", () => {
                bridgeNode = new HueBridge(node, { ...config, autoupdates: false });
                const promise = bridgeNode.autoUpdateFirmware();
                expect(jest.mocked(API.setBridgeUpdate)).not.toBeCalled();
                return promise;
            });
            it("should make an API call to update firmware if config.autoupdates === true", () => {
                bridgeNode = new HueBridge(node, { ...config, autoupdates: true });
                const promise = bridgeNode.autoUpdateFirmware();
                expect(jest.mocked(API.setBridgeUpdate)).toBeCalled();
                return promise;
            });
            it("should make an API call to update firmware if config.autoupdates === undefined", () => {
                bridgeNode = new HueBridge(node, { ...config, autoupdates: undefined });
                const promise = bridgeNode.autoUpdateFirmware();
                expect(jest.mocked(API.setBridgeUpdate)).toBeCalled();
                return promise;
            });

            it("should warn and retry failure", async () => {
                jest.useFakeTimers();
                mockInstantTimeout();
                const error = { error: { type: 1, address: "example", description: "error message" } };
                jest.mocked(API.setBridgeUpdate).mockRejectedValueOnce([ error ]);

                // Mock .autoUpdateFirmware to just resolve(true) after running the first time
                const mockAutoUpdateFirmware = mockRunMethodOnceAndThenNoop(bridgeNode, "autoUpdateFirmware");

                // Trigger an error so we retry
                await bridgeNode.autoUpdateFirmware();
                expect(mockAutoUpdateFirmware).toBeCalledTimes(2);
                expect(nodeWarn).toBeCalledTimes(2);
                expect(nodeWarn).toBeCalledWith(expect.stringContaining("Error response"));
                expect(nodeWarn).toBeCalledWith("error message");

                // It should also have started tracking the timeout
                expect(bridgeNode.firmwareUpdateTimeout).not.toBeUndefined();

                jest.useRealTimers();
            });
            it("should not retry if not enabled", () => {
                bridgeNode.enabled = false;
                const error = { error: { type: 1, address: "example", description: "error message" } };
                jest.mocked(API.setBridgeUpdate).mockRejectedValueOnce([ error ]);
                const result = expect(bridgeNode.autoUpdateFirmware()).resolves.toBe(false);
                return result;
            });
            it("should schedule a retry for 12 hours later on success", async () => {
                jest.useFakeTimers();
                mockInstantTimeout();

                const mockAutoUpdateFirmware = mockRunMethodOnceAndThenNoop(bridgeNode, "autoUpdateFirmware");

                await bridgeNode.autoUpdateFirmware();
                expect(setTimeout).toBeCalledWith(expect.anything(), 12*3600*1000);
                expect(mockAutoUpdateFirmware).toBeCalledTimes(2);

                // It should also have started tracking the timeout
                expect(bridgeNode.firmwareUpdateTimeout).not.toBeUndefined();

                jest.clearAllTimers();
                jest.useRealTimers();
            });
            it("should clear any existing update timers", async () => {
                jest.useFakeTimers();
                mockInstantTimeout();

                const orig = bridgeNode.autoUpdateFirmware;
                const mockAutoUpdateFirmware = jest.spyOn(bridgeNode, "autoUpdateFirmware");

                // Run once to set firmwareUpdateTimeout
                mockAutoUpdateFirmware.mockImplementationOnce(orig);
                mockAutoUpdateFirmware.mockResolvedValueOnce(true);
                await bridgeNode.autoUpdateFirmware();
                expect(setTimeout).toBeCalledWith(expect.anything(), 12*3600*1000);
                expect(mockAutoUpdateFirmware).toBeCalledTimes(2);
                let timeout = bridgeNode.firmwareUpdateTimeout;
                expect(timeout).not.toBeUndefined();

                // Run again to prove we call clearTimeout
                jest.spyOn(global, "clearTimeout").mockClear();
                mockAutoUpdateFirmware.mockImplementationOnce(orig);
                mockAutoUpdateFirmware.mockResolvedValueOnce(true);
                await bridgeNode.autoUpdateFirmware();
                expect(clearTimeout).toHaveBeenCalledTimes(1);
                expect(clearTimeout).toHaveBeenCalledWith(timeout)

                jest.clearAllTimers();
                jest.useRealTimers();
            });
        });
    });
});