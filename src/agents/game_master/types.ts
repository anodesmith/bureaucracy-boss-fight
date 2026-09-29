import type { GameMasterProposal, TurnContext, NarrationBlock } from '../../core/types.js';

/**
 * GAME MASTER
 * ===========
 * Responsible for presenting the scenario, responding to decisions, and
 * choosing among the options the engine has computed as legal this turn.
 *
 * The interface is deliberately tiny. A Game Master gets a `TurnContext` and
 * returns a `GameMasterProposal` whose only consequential field is
 * `chosenOptionId` - one of the ids the engine already offered.
 *
 * It cannot author an effect, a price, a fee, a deadline, or a state change.
 * That is not a policy it follows; it is not in its type signature.
 */
export interface GameMaster {
  readonly name: string;
  /**
   * Structured, explainable decision. No chain-of-thought is ever requested.
   *
   * May be synchronous (demo mode) or asynchronous (model-backed). The engine
   * awaits it; determinism is unaffected because the engine only ever applies
   * an option the scenario already computed.
   */
  propose(context: TurnContext): GameMasterProposal | Promise<GameMasterProposal>;
  /** Opening narration for a new run. */
  opening(context: { title: string; brief: string; objectives: Array<{ title: string; description: string }> }): NarrationBlock[];
}
