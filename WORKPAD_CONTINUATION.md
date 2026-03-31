# Agent Continuation from Incomplete Assistant Messages

## Status: PLANNING

## Goal

Enable extensions to inject an "incomplete" assistant message that the agent will naturally continue from, rather than treating all assistant messages as turn-terminating.

## Use Case

The `/sh` extension wants to inject reasoning that appears as the agent's own thinking, then have the agent continue naturally:

```
User: /sh -i ls -la
    ↓
Extension injects: AssistantMessage "I need to check the files..." (incomplete)
    ↓
Agent continues: "...in this directory. [executes bash tool] [reports results]"
```

**Current behavior**: Agent loop stops when it sees an assistant message.
**Desired behavior**: Agent loop continues if the assistant message is marked incomplete.

---

## Current Architecture

### Message Flow (Simplified)

```
agent.prompt(userMessage)
    ↓
runAgentLoop()
    ↓
while (true) {
    while (hasMoreToolCalls || pendingMessages.length > 0) {
        streamAssistantResponse()  // LLM call
        executeToolCalls()
    }
    check for followUp messages
    if none, break
}
```

### Key Constraint

**File**: `packages/agent/src/agent-loop.ts:64-66`

```typescript
if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
}
```

The agent loop requires the last message to be `user` or `toolResult` before continuing.

### StopReason Types

**File**: `packages/ai/src/types.ts:182`

```typescript
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

No "incomplete" or "continue" value exists.

---

## Implementation Plan

### Phase 1: Type Definitions

#### 1.1 Add `incomplete` field to AssistantMessage

**File**: `packages/ai/src/types.ts`

```typescript
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;
    provider: Provider;
    model: string;
    responseId?: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
    timestamp: number;
    incomplete?: boolean;  // NEW: If true, agent should continue from this message
}
```

**Rationale**: 
- `incomplete: true` signals that the agent loop should treat this as a prefix to be continued
- Optional field (default `undefined` = false) maintains backward compatibility
- Distinct from `stopReason` - an incomplete message may have `stopReason: "stop"` but still need continuation

#### 1.2 Export the updated type

**File**: `packages/ai/src/index.ts`

Ensure `AssistantMessage` with the new field is exported.

---

### Phase 2: Agent Loop Changes

#### 2.1 Modify `agentLoopContinue` validation

**File**: `packages/agent/src/agent-loop.ts:64-66`

**Before**:
```typescript
if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
}
```

**After**:
```typescript
const lastMessage = context.messages[context.messages.length - 1];
if (lastMessage.role === "assistant") {
    // Allow continuation from incomplete assistant messages
    if (!(lastMessage as AssistantMessage).incomplete) {
        throw new Error("Cannot continue from message role: assistant (unless marked incomplete)");
    }
}
```

#### 2.2 Handle incomplete assistant in `runLoop`

**File**: `packages/agent/src/agent-loop.ts`

In the `runLoop` function, after streaming an assistant response, check if it's incomplete:

```typescript
// After: const message = await streamAssistantResponse(...);
newMessages.push(message);

// NEW: If message is incomplete, continue the loop
if (message.incomplete) {
    // Emit turn_end but NOT agent_end - we're continuing
    await emit({ type: "turn_end", message, toolResults: [] });
    
    // Continue the outer loop to get the next assistant response
    // This will naturally pick up any steering/followUp messages
    continue;
}

// Existing error handling...
if (message.stopReason === "error" || message.stopReason === "aborted") {
    // ...
}
```

**Key insight**: An incomplete message should:
1. End the current turn (`turn_end` event)
2. NOT end the agent loop
3. Continue the outer loop, which will trigger another `streamAssistantResponse`
4. The LLM sees the incomplete message as context and continues from it

#### 2.3 Streaming considerations

When an incomplete assistant message exists and we stream the continuation:

- The continuation should APPEND to the existing message content, not create a new message
- OR: Create a new assistant message that the UI merges with the previous one

**Option A (simpler)**: Each continuation is a separate assistant message
- UI merges consecutive assistant messages with same `responseId` or a new `continuationId`
- Clean message boundaries

**Option B (more complex)**: Append to the incomplete message
- Requires mutating the message in-place during streaming
- Cleaner single message, but harder to track what was injected vs generated

**Recommendation**: Start with Option A (separate messages). UI can merge them visually.

---

### Phase 3: Agent Class Changes

#### 3.1 Update `continue()` method

**File**: `packages/agent/src/agent.ts:330-350`

**Before**:
```typescript
if (lastMessage.role === "assistant") {
    // ... throw error or drain queues
    throw new Error("Cannot continue from message role: assistant");
}
```

**After**:
```typescript
if (lastMessage.role === "assistant") {
    // Allow continuation from incomplete assistant messages
    if (!lastMessage.incomplete) {
        const queuedSteering = this.steeringQueue.drain();
        if (queuedSteering.length > 0) {
            await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
            return;
        }
        const queuedFollowUps = this.followUpQueue.drain();
        if (queuedFollowUps.length > 0) {
            await this.runPromptMessages(queuedFollowUps);
            return;
        }
        throw new Error("Cannot continue from message role: assistant (unless marked incomplete)");
    }
    // Continue from incomplete assistant message
    await this.runContinuation();
    return;
}
```

---

### Phase 4: AgentSession API

#### 4.1 Update `sendAssistantMessage` signature

**File**: `packages/coding-agent/src/core/extensions/types.ts`

```typescript
interface ExtensionAPI {
    sendAssistantMessage(
        content: string | (TextContent | ThinkingContent)[],
        options?: {
            thinking?: boolean;
            deliverAs?: "steer" | "followUp" | "nextTurn";
            incomplete?: boolean;  // NEW: Mark message as incomplete
        }
    ): Promise<void>;
}
```

#### 4.2 Implement incomplete handling in AgentSession

**File**: `packages/coding-agent/src/core/agent-session.ts:1317-1350`

```typescript
async sendAssistantMessage(
    content: string | (TextContent | ThinkingContent)[],
    options?: { thinking?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; incomplete?: boolean },
): Promise<void> {
    // ... existing content normalization ...

    const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: blocks,
        api: this.model?.api ?? "anthropic",
        provider: this.model?.provider ?? "anthropic",
        model: this.model?.id ?? "unknown",
        usage: { ...zeroUsage },
        stopReason: "stop",
        timestamp: Date.now(),
        incomplete: options?.incomplete,  // NEW
    };

    this.agent.state.messages.push(assistantMessage);
    this.sessionManager.appendMessage(assistantMessage);

    this._emit({ type: "message_start", message: assistantMessage });
    this._emit({ type: "message_end", message: assistantMessage });

    // NEW: If incomplete and agent is idle, trigger continuation
    if (options?.incomplete && !this.isStreaming) {
        await this.agent.continue();
    }
}
```

**Important**: Only call `agent.continue()` if the agent is idle. If streaming, the message will be picked up naturally.

---

### Phase 5: UI Considerations

#### 5.1 Display incomplete messages differently

**File**: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`

Add visual indicator for incomplete messages:
- Maybe a subtle border or "..." suffix
- Shows that the agent will continue

#### 5.2 Merge consecutive assistant messages (optional)

If we go with Option A (separate messages), the UI could visually merge:
- Check if previous message was incomplete
- If so, append without separator
- Creates seamless appearance of continuation

---

## Testing Strategy

### Unit Tests

1. **agent-loop.test.ts**:
   - Test that incomplete assistant messages allow continuation
   - Test that complete assistant messages still throw
   - Test that continuation appends to conversation correctly

2. **agent.test.ts**:
   - Test `agent.continue()` with incomplete message
   - Test that incomplete + steering messages work together

### Integration Tests

1. Create an incomplete assistant message manually
2. Call `agent.continue()`
3. Verify LLM receives the incomplete message as context
4. Verify continuation is appended correctly

### Manual Testing

1. Use `/sh -i ls -la`
2. Verify reasoning appears as assistant thinking
3. Verify agent continues naturally
4. Verify output appears as continuation, not new turn

---

## Rollout Plan

### Step 1: Core Types (Non-Breaking)
- Add `incomplete?: boolean` to `AssistantMessage`
- No behavior changes yet

### Step 2: Agent Loop (With Flag)
- Modify validation to allow incomplete
- Add tests for new behavior
- Feature is now usable but not exposed in API

### Step 3: AgentSession API
- Add `incomplete` option to `sendAssistantMessage`
- Wire up `agent.continue()` trigger
- Feature fully functional

### Step 4: /sh Extension
- Implement `-i` flag using incomplete messages
- Test end-to-end flow

### Step 5: UI Polish
- Add visual indicators
- Consider message merging

---

## Files to Modify

1. `packages/ai/src/types.ts` - Add `incomplete` field
2. `packages/ai/src/index.ts` - Export updated type
3. `packages/agent/src/agent-loop.ts` - Allow continuation from incomplete
4. `packages/agent/src/agent.ts` - Update `continue()` method
5. `packages/coding-agent/src/core/extensions/types.ts` - API signature
6. `packages/coding-agent/src/core/agent-session.ts` - Implementation
7. `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` - UI indicator (optional)

---

## Open Questions

1. **Streaming UI**: How should the UI display the transition from injected incomplete to streamed continuation?
   - Option: Show incomplete with "..." animation, then append streamed content
   - Option: Hide incomplete until continuation starts streaming

2. **Message attribution**: Should we track which parts were injected vs generated?
   - Could use `details` field to mark "injected by extension"
   - Useful for debugging and transparency

3. **stopReason for incomplete**: Should incomplete messages have a specific stopReason?
   - Current plan: Use `"stop"` but with `incomplete: true`
   - Alternative: Add `"incomplete"` to StopReason type (more explicit but more invasive)

4. **Multiple continuations**: What if an extension injects multiple incomplete messages?
   - Each should trigger continuation in sequence
   - Or: Error, only allow one incomplete at a time

---

## Success Criteria

1. `/sh -i ls -la` injects reasoning as incomplete assistant message
2. Agent continues naturally without error
3. Continuation appears seamless in UI
4. No message count confusion (agent sees one logical turn)
5. Backward compatible - existing code unaffected

---

## Reference

Related workpad: `/home/herwig/.pi/WORKPAD_SH.md`