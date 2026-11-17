# -*-coding:utf-8 -*-
# python 3.9
# 计算每个城市每项的CBA
# 针对每个城市的所有格子进行bootstrap有放回抽样，得到CI
# 单位是dollar

"""
# @File       : 14_CBA_byCity(CI).py
# @software   : PyCharm  
# @Time       ：2025/5/7 17:27
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    sigma = 1
    capacity = 50000

    area_ph = 1.5
    shelter_building_pa = 2990 
    min_capacity = 500  # capacity per shelter

    # cost:
    one_time_installation = (63.53 + 80.85) / 2 / 10 + 150 / 10 * shelter_building_pa  # one-time installation
    aom = 0.68705 * 10 ** 5  # annual operation and maintenance
    insurance_rate = 0.0005

    # benefits:
    disaster_mitigation_fund = 1.127139318
    direct_economic_loss = 2445.7 * 10 ** 8 / (5278.9 * 10 ** 4)
    medical_aid = (361.6 + 10315.8) / 2 
    carbon_emission_factor = 93.981
    carbon_emission_price = 90.97

    exchange_rate = 0.1393

    n_simulations = 1000

    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    priority_scenarios = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]
    suffixes = ['_sc', '_oti', '_aom', '_insur', '_dmf', '_del', '_ma', '_ce']

    sum1 = 0 
    for i in range(len(cities)):
        # i = 0
        city = cities[i]
        data_path = path + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        inflowPredShelter = pd.read_csv(data_path + '/inflowPredShelter.csv', header=0)

        inflowPredShelter['difference'] = inflowPredShelter['Shelter_count'] * capacity - inflowPredShelter['pred_inflow']
        inflowPredShelter['diff'] = -(inflowPredShelter.loc[inflowPredShelter['difference'] < -50, 'difference'])  # save casualties

        df_dist = pd.read_csv(path + '/Result/cities_21_max/' + city + '/tid_to_shelter_distance.csv', header=0)

        inflowPredShelter = inflowPredShelter.merge(df_dist, on='Tid', how='left')
        del df_dist

        result = pd.DataFrame(columns=['priority{}{}'.format(p, s) for p in priority_scenarios for s in suffixes])

        for j in range(n_simulations+1):
            if j == 0:
                df_bs = inflowPredShelter.copy()
            else:
                df_bs = inflowPredShelter.sample(n=len(inflowPredShelter), replace=True).copy()
                break   # 统计sum1

            df_bs['difference'] = df_bs['Shelter_count'] * capacity - df_bs['pred_inflow']

            # priority top scenario
            filtered_data = df_bs[df_bs['difference'] < -50] 

            rows = []
            for prop in priority_scenarios:
                threshold = filtered_data['difference'].quantile(prop)  # 获取前X%的最小值
                top_percent_min = filtered_data[filtered_data['difference'] <= threshold].copy()
                # top30% strategy
                if prop == 0.3:
                    tmp = top_percent_min['diff'].sum()
                    sum1 += tmp
                top_percent_min['priority' + str(prop) + '_sc'] = np.ceil(-(top_percent_min.loc[:, 'difference']) / min_capacity)
                # costs:
                top_percent_min['priority' + str(prop) + '_oti'] = top_percent_min['priority' + str(prop) + '_sc'] * one_time_installation * exchange_rate
                top_percent_min['priority' + str(prop) + '_aom'] = top_percent_min['priority' + str(prop) + '_sc'] * aom * exchange_rate
                top_percent_min['priority' + str(prop) + '_insur'] = top_percent_min['priority' + str(prop) + '_oti'] * insurance_rate * exchange_rate
                # benefits:
                top_percent_min['priority' + str(prop) + '_dmf'] = top_percent_min['diff'] * disaster_mitigation_fund * exchange_rate
                top_percent_min['priority' + str(prop) + '_del'] = top_percent_min['diff'] * direct_economic_loss * exchange_rate
                top_percent_min['priority' + str(prop) + '_ma'] = top_percent_min['diff'] * medical_aid * exchange_rate
               
                top_percent_min['priority' + str(prop) + '_ce'] = top_percent_min[
                                                           'diff'] * top_percent_min['Dist_km'] * carbon_emission_factor / 10 ** 6 * carbon_emission_price * exchange_rate

                fields = ['priority' + str(prop) + sfx for sfx in suffixes]
                top_percent_min[fields] = top_percent_min[fields].fillna(0)

                row_prop = top_percent_min[fields].sum(axis=0)
                rows.extend(row_prop)

                del threshold, top_percent_min, row_prop

            result.loc[len(result), :] = rows

            del df_bs

        # result.to_csv(data_path + '/scenarios.csv', header=True, index=False)
        del result
        print(city)
    print(sum1)
