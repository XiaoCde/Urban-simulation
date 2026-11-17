# -*-coding:utf-8 -*-
# python 2.7
# 处理所有城市sa.shp，进行编码，为后续导入geoda进行空间聚类做准备

"""
# @File       : 6_SP_sa_generation.py
# @software   : PyCharm  
# @Time       ：2025/5/5 15:21
# @Author     ：Wei Lyu
"""

import arcpy

if __name__ == '__main__':
    sigma = 1
    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    for city in cities:
        sa_shp = r'D:\LW\ABM\OutputData\Result\cities_21_max' + '\\' + city + '\\sigma=' + str(sigma) + '\\' + 'sa.shp'
        fields_to_delete = ["Tid_12", "pred_inflo", "Shelter_co", "inflowPerS", "500_Match_", "50000_Matc"]  # 要删除的字段名

        arcpy.DeleteField_management(sa_shp, drop_field=fields_to_delete)

        # 添加字段（如果字段已存在，可以跳过或用 try/except）
        arcpy.AddField_management(sa_shp, "Code_defic", "SHORT")
        arcpy.AddField_management(sa_shp, "Code_surpl", "SHORT")

        # 使用 Field Calculator 赋值
        # Code_defic: 如果 match_type == 'deficit'，则为 1，否则为 0
        arcpy.CalculateField_management(
            in_table=sa_shp,
            field="Code_defic",
            expression="1 if !match_type! == 'deficit' else 0",
            expression_type="PYTHON"
        )

        # Code_surpl: 如果 match_type == 'surplus'，则为 1，否则为 0
        arcpy.CalculateField_management(
            in_table=sa_shp,
            field="Code_surpl",
            expression="1 if !match_type! == 'surplus' else 0",
            expression_type="PYTHON"
        )
        print(city)