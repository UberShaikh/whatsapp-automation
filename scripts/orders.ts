import { parseArgs } from 'node:util';
import { loadConfig } from '../app/config.ts';
import { assertSchema,createPool,transaction } from '../app/db.ts';
import { transitionOrder } from '../app/checkout.ts';

async function main() {
  const {values}=parseArgs({options:{order:{type:'string'},action:{type:'string'},'cash-received':{type:'boolean',default:false}}});
  if (values.order && !/^D-[A-F0-9]{12}$/i.test(values.order)) throw new Error('Invalid order reference');
  if (Boolean(values.order)!==Boolean(values.action)) throw new Error('Supply --order and --action together');
  if (values.action && !['accept','pick','ready','collect','cancel','reject'].includes(values.action)) throw new Error('Unknown order action');
  const config=loadConfig();const pool=createPool(config.databaseUrl);
  const scope=[config.businessAccountId,config.phoneNumberId,config.mode];
  try {
    await assertSchema(pool);
    if (values.order) console.log(await transaction(pool,async db=>{
      const identity=await db.query(`SELECT i.id FROM grocery_dev.wa_identities i JOIN grocery_dev.wa_orders o ON o.identity_id=i.id
        WHERE i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode=$3 AND o.reference=$4 FOR UPDATE OF i`,[...scope,values.order!.toUpperCase()]);
      if (!identity.rowCount) throw new Error('No order in this configured scope');
      const {rows}=await db.query('SELECT * FROM grocery_dev.wa_orders WHERE reference=$1 FOR UPDATE',[values.order!.toUpperCase()]);
      return transitionOrder(db,rows[0],values.action!,'operator',values['cash-received']);
    }));
    else {
      const {rows}=await pool.query(`SELECT o.reference,o.state,o.payment_status,o.total,o.created_at,o.updated_at,
        (o.state='PLACED' AND o.created_at<now()-interval '30 minutes') AS needs_acceptance_review
        FROM grocery_dev.wa_orders o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
        WHERE i.business_account_id=$1 AND i.phone_number_id=$2 AND i.transport_mode=$3 ORDER BY o.created_at DESC LIMIT 50`,scope);
      console.log(JSON.stringify({mode:config.mode,demo:true,orders:rows},null,2));
    }
  } finally {await pool.end();}
}
if (import.meta.main) main().catch(()=>{console.error('Order operation failed. Check scope, reference, action and database readiness. No credentials or customer data are logged.');process.exitCode=1;});
