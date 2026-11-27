use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{vrf, vrf_callback},
    vrf::{
        consts::{program_identity_pubkey, DEFAULT_QUEUE},
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

// Replace the template address via `anchor keys sync` before the devnet build.
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZp6W2BeZ7FEfcYkgMQhg");

const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
const DAY_SECONDS: i64 = 86_400;

#[program]
pub mod stack_seed {
    use super::*;

    pub fn request_seed(ctx: Context<RequestSeed>, day: u32) -> Result<()> {
        let today = Clock::get()?.unix_timestamp.div_euclid(DAY_SECONDS);
        require!(i64::from(day) == today, SeedError::WrongDay);
        ctx.accounts.daily.day = day;
        let day_bytes = day.to_le_bytes();
        let mut caller_seed = [0u8; 32];
        caller_seed[..4].copy_from_slice(&day_bytes);
        let request = RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ReceiveSeed::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.daily.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(day_bytes.to_vec()),
            ..Default::default()
        };
        let ix = create_request_randomness_ix_const(request, PROGRAM_IDENTITY);
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn receive_seed(ctx: Context<ReceiveSeed>, randomness: [u8; 32], day: u32) -> Result<()> {
        let daily = &mut ctx.accounts.daily;
        require!(daily.day == day, SeedError::WrongDay);
        require!(!daily.ready, SeedError::AlreadyReady);
        daily.randomness = randomness;
        daily.ready = true;
        let seed = u32::from_le_bytes(randomness[..4].try_into().unwrap());
        msg!("STACK_SEED {} {}", day, seed);
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
#[instruction(day: u32)]
pub struct RequestSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + DailySeed::INIT_SPACE, seeds = [b"day".as_ref(), day.to_le_bytes().as_ref()], bump)]
    pub daily: Account<'info, DailySeed>,
    /// CHECK: only the canonical base-layer queue may serve this request.
    #[account(mut, address = DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[vrf_callback]
#[derive(Accounts)]
#[instruction(randomness: [u8; 32], day: u32)]
pub struct ReceiveSeed<'info> {
    #[account(mut, seeds = [b"day".as_ref(), day.to_le_bytes().as_ref()], bump)]
    pub daily: Account<'info, DailySeed>,
}

#[account]
#[derive(InitSpace)]
pub struct DailySeed {
    pub day: u32,
    pub ready: bool,
    pub randomness: [u8; 32],
}

#[error_code]
pub enum SeedError {
    #[msg("The request date must match the current UTC day.")]
    WrongDay,
    #[msg("The seed for this day has already been finalized.")]
    AlreadyReady,
}
